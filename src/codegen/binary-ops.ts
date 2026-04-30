// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Binary operations extracted from expressions.ts.
 * Handles binary expression compilation including numeric, i32, i64,
 * bitwise, modulo, boolean, and any-typed binary operations.
 */
import ts from "typescript";
import {
  isBigIntType,
  isBooleanType,
  isNumberType,
  isStringType,
  isWrapperObjectType,
} from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { isAnyValue } from "./any-helpers.js";
import { reportError } from "./context/errors.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  compileAssignment,
  compileCompoundAssignment,
  compileLogicalAssignment,
  isCompoundAssignment,
} from "./expressions/assignment.js";
import { emitThrowString } from "./expressions/helpers.js";
import { ensureExternIsUndefinedImport, ensureLateImport } from "./expressions/late-imports.js";
import { compileLogicalAnd, compileLogicalOr, compileNullishCoalescing } from "./expressions/logical-ops.js";
import { tryStaticToNumber } from "./expressions/misc.js";
import { addStringImports, addUnionImports, resolveNativeTypeAnnotation, resolveWasmType } from "./index.js";
import type { InnerResult } from "./shared.js";
import { coerceType, compileExpression, ensureAnyHelpers, flushLateImportShifts } from "./shared.js";
import { compileStringBinaryOp } from "./string-ops.js";
import { compileInstanceOf, compileTypeofComparison } from "./typeof-delete.js";

// ── Binary operations ─────────────────────────────────────────────────

/**
 * Operators eligible for chain flattening — arithmetic and bitwise ops that
 * take two numeric operands and produce a numeric result of the same type.
 * We exclude ** (exponentiation) because it calls Math_pow and comparison
 * operators because they produce i32 (boolean), not f64.
 */
const FLATTENABLE_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
  ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

/**
 * Try to flatten a left-recursive chain of the same binary operator into an
 * iterative compilation. For expressions like `a + b + c + d` (AST:
 * `((a + b) + c) + d`), this avoids O(n) JS call-stack depth and improves
 * compilation speed for long chains.
 *
 * Returns null if flattening is not applicable (not the same operator
 * throughout, non-numeric operands, chain too short, etc.).
 */
function tryFlattenBinaryChain(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult | null {
  // Only flatten operators that produce the same type as their inputs
  if (!FLATTENABLE_OPS.has(op)) return null;

  // Must have at least 3 operands (i.e., left is also a binary expr with same op)
  if (!ts.isBinaryExpression(expr.left) || expr.left.operatorToken.kind !== op) {
    return null;
  }

  // Collect all leaf operands by walking the left-recursive spine
  const operands: ts.Expression[] = [];
  let node: ts.Expression = expr;
  while (ts.isBinaryExpression(node) && node.operatorToken.kind === op) {
    operands.push(node.right);
    node = node.left;
  }
  operands.push(node); // leftmost operand
  operands.reverse(); // now in left-to-right order

  // Verify all operands are numeric (not string, not any, not bigint)
  // If plus and any operand is a string type, bail out — it's string concat
  for (const operand of operands) {
    const tsType = ctx.checker.getTypeAtLocation(operand);
    if (isStringType(tsType)) return null;
    if (isBigIntType(tsType)) return null;
    if ((tsType.flags & ts.TypeFlags.Any) !== 0) return null;
  }

  // Determine numeric hint — also check if all operands use native i32 type annotations
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  let allNativeI32 = !isDivOrPow;
  if (allNativeI32 && !ctx.fast) {
    for (const operand of operands) {
      const tsType = ctx.checker.getTypeAtLocation(operand);
      const native = resolveNativeTypeAnnotation(tsType);
      if (native?.kind !== "i32") {
        allNativeI32 = false;
        break;
      }
    }
  }
  const numericHint: ValType = { kind: (ctx.fast || allNativeI32) && !isDivOrPow ? "i32" : "f64" };

  // Compile first operand
  let resultType = compileExpression(ctx, fctx, operands[0], numericHint);
  if (!resultType) return null;

  // Compile subsequent operands, emitting the operator after each pair
  for (let i = 1; i < operands.length; i++) {
    let rightType = compileExpression(ctx, fctx, operands[i], numericHint);
    if (!rightType) return null;

    // Coerce ref/externref operands to f64 for numeric operations
    const leftIsRef = resultType.kind === "externref" || resultType.kind === "ref" || resultType.kind === "ref_null";
    const rightIsRef = rightType.kind === "externref" || rightType.kind === "ref" || rightType.kind === "ref_null";
    if (leftIsRef || rightIsRef) {
      if (rightIsRef) {
        const tmpR = allocTempLocal(fctx, rightType);
        fctx.body.push({ op: "local.set", index: tmpR });
        if (leftIsRef) {
          coerceType(ctx, fctx, resultType, { kind: "f64" });
        }
        fctx.body.push({ op: "local.get", index: tmpR });
        coerceType(ctx, fctx, rightType, { kind: "f64" });
        releaseTempLocal(fctx, tmpR);
      } else {
        const tmpR = allocTempLocal(fctx, rightType);
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, resultType, { kind: "f64" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      resultType = { kind: "f64" };
      rightType = { kind: "f64" };
    }

    // Promote i32/f64 mismatch
    if (resultType.kind === "i32" && rightType.kind === "f64") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
      resultType = { kind: "f64" };
      rightType = { kind: "f64" };
    } else if (resultType.kind === "f64" && rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      rightType = { kind: "f64" };
    }

    // i32 path: fast mode or native type annotations
    if ((ctx.fast || allNativeI32) && resultType.kind === "i32" && rightType.kind === "i32") {
      resultType = compileI32BinaryOp(ctx, fctx, op, expr);
    } else {
      resultType = compileNumericBinaryOp(ctx, fctx, op, expr);
    }
  }

  return resultType;
}

export function compileBinaryExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): InnerResult {
  const op = expr.operatorToken.kind;

  // Handle assignment
  if (op === ts.SyntaxKind.EqualsToken) {
    return compileAssignment(ctx, fctx, expr);
  }

  // Handle logical assignment operators (??=, ||=, &&=)
  if (
    op === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    op === ts.SyntaxKind.BarBarEqualsToken ||
    op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  ) {
    return compileLogicalAssignment(ctx, fctx, expr, op);
  }

  // Handle compound assignments
  if (isCompoundAssignment(op)) {
    return compileCompoundAssignment(ctx, fctx, expr, op);
  }

  // Handle logical && and ||
  if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
    return compileLogicalAnd(ctx, fctx, expr);
  }
  if (op === ts.SyntaxKind.BarBarToken) {
    return compileLogicalOr(ctx, fctx, expr);
  }

  // Nullish coalescing: a ?? b
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return compileNullishCoalescing(ctx, fctx, expr);
  }

  // ── Fast path: `expr | 0` → pure ToInt32 coercion ──
  // In JavaScript, `x | 0` is idiomatically used to coerce a number to int32.
  // Since OR-ing with 0 is the identity for the bit pattern, we can skip
  // compiling the right operand entirely and just emit ToInt32 on the left.
  // This avoids the expensive double-ToInt32 + i32.or + f64.convert sequence
  // that compileBitwiseBinaryOp would generate.
  //
  // #1120: when the left operand is already i32 (e.g. an i32-coerced
  // local from collectI32CoercedLocals, or another `| 0` expression),
  // return i32 directly — the f64.convert_i32_s round-trip would be
  // immediately undone by the receiving local's ToInt32 coercion.
  // Callers that need an f64 (function args, f64 locals, etc.) still go
  // through coerceType which handles the i32 → f64 widening.
  if (op === ts.SyntaxKind.BarToken && ts.isNumericLiteral(expr.right) && expr.right.text === "0") {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (!leftType) return null;
    if (leftType.kind === "f64") {
      emitToInt32(fctx);
      return { kind: "i32" };
    } else if (leftType.kind === "i32") {
      // Already i32 — `x | 0` is identity, no work to do.
      return { kind: "i32" };
    } else if (leftType.kind === "externref") {
      // externref → coerce to f64 first, then ToInt32
      const pfIdx = ctx.funcMap.get("parseFloat");
      if (pfIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: pfIdx });
      } else {
        addUnionImports(ctx);
        const unboxIdx = ctx.funcMap.get("__unbox_number")!;
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
      }
      emitToInt32(fctx);
      return { kind: "i32" };
    } else {
      // ref/ref_null — coerce to f64 via valueOf, then ToInt32
      coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
      emitToInt32(fctx);
      return { kind: "i32" };
    }
  }

  // Comma operator: (a, b) — evaluate a, drop its value, evaluate b
  if (op === ts.SyntaxKind.CommaToken) {
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    return compileExpression(ctx, fctx, expr.right);
  }

  // instanceof: compile left value, resolve right to struct type, emit ref.test
  if (op === ts.SyntaxKind.InstanceOfKeyword) {
    return compileInstanceOf(ctx, fctx, expr);
  }

  // typeof x === "type" / typeof x !== "type"
  if (
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken
  ) {
    const typeofResult = compileTypeofComparison(ctx, fctx, expr);
    if (typeofResult !== null) return typeofResult;
  }

  // Null comparison shortcut: x === null, x !== null, null === x, null !== x
  // Must be detected before compiling both sides to avoid pushing unnecessary null
  const isEqOp = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeqOp = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  const isStrictEqOp = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isStrictNeqOp = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLooseEqOp = op === ts.SyntaxKind.EqualsEqualsToken;
  const isLooseNeqOp = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (isEqOp || isNeqOp) {
    const rightIsNullKeyword = expr.right.kind === ts.SyntaxKind.NullKeyword;
    const rightIsUndefinedId = ts.isIdentifier(expr.right) && expr.right.text === "undefined";
    const rightIsNullish = rightIsNullKeyword || rightIsUndefinedId;
    const leftIsNullKeyword = expr.left.kind === ts.SyntaxKind.NullKeyword;
    const leftIsUndefinedId = ts.isIdentifier(expr.left) && expr.left.text === "undefined";
    const leftIsNullish = leftIsNullKeyword || leftIsUndefinedId;
    if (rightIsNullish || leftIsNullish) {
      // Determine which side is the literal null/undefined and which is the expression
      const nonNullExpr = rightIsNullish ? expr.left : expr.right;

      // Check if the non-null side is also a null/undefined literal
      const nonNullIsNullKeyword = rightIsNullish ? leftIsNullKeyword : rightIsNullKeyword;
      const nonNullIsUndefinedId = rightIsNullish ? leftIsUndefinedId : rightIsUndefinedId;
      const nullSideIsNullKeyword = rightIsNullish ? rightIsNullKeyword : leftIsNullKeyword;
      const nullSideIsUndefinedId = rightIsNullish ? rightIsUndefinedId : leftIsUndefinedId;

      // Both sides are null/undefined literals
      if (nonNullIsNullKeyword || nonNullIsUndefinedId) {
        // For strict equality: null === null or undefined === undefined → true;
        //                      null === undefined → false
        if (isStrictEqOp || isStrictNeqOp) {
          const sameKind =
            (nonNullIsNullKeyword && nullSideIsNullKeyword) || (nonNullIsUndefinedId && nullSideIsUndefinedId);
          fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : sameKind ? 0 : 1 });
          return { kind: "i32" };
        }
        // For loose equality: null == undefined → true
        fctx.body.push({ op: "i32.const", value: isLooseEqOp ? 1 : 0 });
        return { kind: "i32" };
      }

      // Check the TS type of the non-null side to detect undefined/null-typed variables
      const nonNullTsType = ctx.checker.getTypeAtLocation(nonNullExpr);
      const nonNullIsUndefinedType =
        (nonNullTsType.flags & ts.TypeFlags.Undefined) !== 0 || (nonNullTsType.flags & ts.TypeFlags.Void) !== 0;
      const nonNullIsNullType = (nonNullTsType.flags & ts.TypeFlags.Null) !== 0;

      // Compile the non-null side
      const valType = compileExpression(ctx, fctx, nonNullExpr);
      if (valType === null) {
        // Void expression (e.g. void function call) compared to null/undefined:
        // void returns undefined, so undefined == undefined/null is true (loose)
        // undefined === undefined is true, undefined === null is false (strict)
        if (isStrictEqOp || isStrictNeqOp) {
          const sameKind = nullSideIsUndefinedId; // void = undefined
          fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : sameKind ? 0 : 1 });
        } else {
          fctx.body.push({ op: "i32.const", value: isEqOp ? 1 : 0 });
        }
        return { kind: "i32" };
      }
      if (valType.kind === "externref") {
        // Strict equality: null and undefined are distinct types in JS
        if (isStrictEqOp || isStrictNeqOp) {
          if (nullSideIsNullKeyword) {
            // x === null: only ref.null.extern is null
            fctx.body.push({ op: "ref.is_null" });
            if (isStrictNeqOp) fctx.body.push({ op: "i32.eqz" });
            return { kind: "i32" };
          }
          // x === undefined: check via __extern_is_undefined host import
          const isUndefIdx = ensureExternIsUndefinedImport(ctx);
          if (isUndefIdx !== undefined) {
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "call", funcIdx: isUndefIdx });
            if (isStrictNeqOp) fctx.body.push({ op: "i32.eqz" });
            return { kind: "i32" };
          }
          // Fallback (standalone): ref.is_null (can't distinguish null/undefined)
          fctx.body.push({ op: "ref.is_null" });
          if (isStrictNeqOp) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // Loose equality: null == undefined is true in JS, so check both
        const isUndefIdx = ensureExternIsUndefinedImport(ctx);
        if (isUndefIdx !== undefined) {
          flushLateImportShifts(ctx, fctx);
          const tmpLocal = allocTempLocal(fctx, { kind: "externref" });
          fctx.body.push({ op: "local.tee", index: tmpLocal });
          fctx.body.push({ op: "ref.is_null" });
          fctx.body.push({ op: "local.get", index: tmpLocal });
          fctx.body.push({ op: "call", funcIdx: isUndefIdx });
          fctx.body.push({ op: "i32.or" } as Instr);
          releaseTempLocal(fctx, tmpLocal);
          if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.is_null" });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // Non-externref type compared with null/undefined:
      // If the TS type is undefined or null, it's a nullish value stored as i32
      if (nonNullIsUndefinedType || nonNullIsNullType) {
        fctx.body.push({ op: "drop" });
        // Loose equality: undefined/null == null/undefined → true
        if (isLooseEqOp || isLooseNeqOp) {
          fctx.body.push({ op: "i32.const", value: isLooseEqOp ? 1 : 0 });
          return { kind: "i32" };
        }
        // Strict equality: only true if same kind
        const sameKind =
          (nonNullIsUndefinedType && nullSideIsUndefinedId) || (nonNullIsNullType && nullSideIsNullKeyword);
        fctx.body.push({ op: "i32.const", value: isStrictEqOp ? (sameKind ? 1 : 0) : sameKind ? 0 : 1 });
        return { kind: "i32" };
      }
      // For ref/ref_null struct types:
      // Strict: refs can be null but never undefined
      // Loose: null == undefined, so ref.is_null covers both
      if (valType.kind === "ref" || valType.kind === "ref_null") {
        if ((isStrictEqOp || isStrictNeqOp) && nullSideIsUndefinedId) {
          // struct === undefined → always false; struct !== undefined → always true
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: isStrictNeqOp ? 1 : 0 });
          return { kind: "i32" };
        }
        fctx.body.push({ op: "ref.is_null" });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
      // For other non-externref types (number, boolean), always not-equal to null/undefined
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isNeqOp ? 1 : 0 });
      return { kind: "i32" };
    }
  }

  // `key in obj` — compile-time property existence check
  if (op === ts.SyntaxKind.InKeyword) {
    const rightType = ctx.checker.getTypeAtLocation(expr.right);
    const rightWasm = resolveWasmType(ctx, rightType);

    // Get struct field names if available; detect vec (array) types
    let structFieldNames: string[] | null = null;
    let isVecType = false;
    let vecTypeIdx = -1;
    if (rightWasm.kind === "ref" || rightWasm.kind === "ref_null") {
      const typeIdx = (rightWasm as { typeIdx: number }).typeIdx;
      const structDef = ctx.mod.types[typeIdx];
      if (structDef?.kind === "struct") {
        if (structDef.name?.startsWith("__vec_")) {
          isVecType = true;
          vecTypeIdx = typeIdx;
        } else {
          structFieldNames = structDef.fields.map((f) => f.name).filter((n): n is string => n !== undefined);
        }
      }
    }

    // Resolve the key to a compile-time string if possible.
    // For comma expressions like (x = y, "key"), extract the last element.
    // For PrivateIdentifier (#field in obj), extract the field name without '#'.
    let staticKey: string | null = null;
    const leftExpr: ts.Expression = expr.left;
    if (ts.isPrivateIdentifier(leftExpr)) {
      staticKey = leftExpr.text.startsWith("#") ? "__priv_" + leftExpr.text.slice(1) : leftExpr.text;
    } else if (ts.isStringLiteral(leftExpr)) {
      staticKey = leftExpr.text;
    } else if (ts.isNumericLiteral(leftExpr)) {
      staticKey = leftExpr.text;
    } else if (ts.isBinaryExpression(leftExpr) && leftExpr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // Comma expression: extract the last element for the static key
      let last: ts.Expression = leftExpr.right;
      while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        last = last.right;
      }
      if (ts.isStringLiteral(last)) {
        staticKey = last.text;
      } else if (ts.isNumericLiteral(last)) {
        staticKey = last.text;
      }
    } else if (ts.isParenthesizedExpression(leftExpr)) {
      // Parenthesized expression: unwrap and check for comma or literal
      const inner = leftExpr.expression;
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        let last: ts.Expression = inner.right;
        while (ts.isBinaryExpression(last) && last.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          last = last.right;
        }
        if (ts.isStringLiteral(last)) {
          staticKey = last.text;
        } else if (ts.isNumericLiteral(last)) {
          staticKey = last.text;
        }
      } else if (ts.isStringLiteral(inner)) {
        staticKey = inner.text;
      } else if (ts.isNumericLiteral(inner)) {
        staticKey = inner.text;
      }
    }

    // Also check the TypeScript type system for property existence.
    // This handles built-in constructors (Number.MAX_VALUE), prototype methods
    // (valueOf, toString), and dynamically assigned properties.
    let tsTypeHasProperty = false;
    if (staticKey !== null) {
      // Check direct properties on the TypeScript type
      const prop = rightType.getProperty(staticKey);
      if (prop) {
        tsTypeHasProperty = true;
      }
      // Check the right side's type for comma expressions too
      if (
        !tsTypeHasProperty &&
        ts.isBinaryExpression(expr.right) &&
        expr.right.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        let lastRight: ts.Expression = expr.right.right;
        while (ts.isBinaryExpression(lastRight) && lastRight.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          lastRight = lastRight.right;
        }
        const lastRightType = ctx.checker.getTypeAtLocation(lastRight);
        const prop2 = lastRightType.getProperty(staticKey);
        if (prop2) tsTypeHasProperty = true;
      }
      // Also check apparent type (includes prototype methods like valueOf, toString)
      if (!tsTypeHasProperty) {
        const apparentType = ctx.checker.getApparentType(rightType);
        const apparentProp = apparentType.getProperty(staticKey);
        if (apparentProp) tsTypeHasProperty = true;
      }
    }

    // Array (vec) index bounds check: `index in arr` → 0 <= index < arr.length
    if (isVecType && staticKey !== null) {
      const numIdx = Number(staticKey);
      if (Number.isFinite(numIdx) && numIdx >= 0 && Number.isInteger(numIdx)) {
        // Evaluate left for side effects, drop result
        const leftResult = compileExpression(ctx, fctx, expr.left);
        if (leftResult) {
          fctx.body.push({ op: "drop" });
        }
        // Compile the array expression to get the vec struct
        const rightResult = compileExpression(ctx, fctx, expr.right);
        if (rightResult) {
          // Read length field (field 0 of vec struct)
          fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
          // Compare: numIdx < length
          fctx.body.push({ op: "i32.const", value: numIdx });
          fctx.body.push({ op: "i32.gt_s" }); // length > index  <==>  index < length
        } else {
          fctx.body.push({ op: "i32.const", value: 0 });
        }
        return { kind: "i32" };
      }
      // Non-numeric key like "length" on array — check TS type
      if (staticKey === "length") {
        const leftResult = compileExpression(ctx, fctx, expr.left);
        if (leftResult) {
          fctx.body.push({ op: "drop" });
        }
        const rightResult = compileExpression(ctx, fctx, expr.right);
        if (rightResult) {
          fctx.body.push({ op: "drop" });
        }
        fctx.body.push({ op: "i32.const", value: 1 });
        return { kind: "i32" };
      }
    }

    // Static resolution: key is known at compile time
    if (staticKey !== null) {
      const hasInStruct = structFieldNames !== null && structFieldNames.includes(staticKey);
      const has = hasInStruct || tsTypeHasProperty;
      // Evaluate both operands for side effects (needed for comma expressions like
      // (NUMBER = Number, "MAX_VALUE") in NUMBER). Drop the produced values.
      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult) {
        fctx.body.push({ op: "drop" });
      }
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult) {
        fctx.body.push({ op: "drop" });
      }
      fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
      return { kind: "i32" };
    }

    // Dynamic key with known struct fields: runtime string comparison
    if (structFieldNames !== null && structFieldNames.length > 0) {
      // Compile the key expression (should produce a string/externref)
      const keyType = compileExpression(ctx, fctx, expr.left);
      if (keyType) {
        // Compare key against each field name using wasm:js-string equals
        const equalsIdx = ctx.funcMap.get("__str_eq") ?? ctx.funcMap.get("string_equals");
        const jsStrEquals = ctx.mod.imports.findIndex(
          (imp) => imp.module === "wasm:js-string" && imp.name === "equals",
        );
        const eqFunc = jsStrEquals >= 0 ? jsStrEquals : equalsIdx;
        if (eqFunc !== undefined && eqFunc >= 0) {
          const keyLocal = allocLocal(fctx, `__in_key_${fctx.locals.length}`, keyType);
          fctx.body.push({ op: "local.set", index: keyLocal });
          // Start with false (0)
          fctx.body.push({ op: "i32.const", value: 0 });
          for (const fieldName of structFieldNames) {
            // Load the key and the field name string, compare
            fctx.body.push({ op: "local.get", index: keyLocal });
            const strGlobal = ctx.stringGlobalMap.get(fieldName);
            if (strGlobal !== undefined) {
              fctx.body.push({ op: "global.get", index: strGlobal });
              fctx.body.push({ op: "call", funcIdx: eqFunc });
              fctx.body.push({ op: "i32.or" }); // OR with accumulated result
            }
          }
          return { kind: "i32" };
        }
      }
    }

    // Dynamic key with no struct fields — try TS type system for known properties
    // Compile both sides for side effects, then use TS type system if the key
    // can be resolved from its type (e.g., a string variable with a known literal type).
    {
      const leftResult = compileExpression(ctx, fctx, expr.left);
      if (leftResult) {
        fctx.body.push({ op: "drop" });
      }
      const rightResult = compileExpression(ctx, fctx, expr.right);
      if (rightResult) {
        fctx.body.push({ op: "drop" });
      }

      // Try to resolve key from the TS type of the left expression
      const leftType = ctx.checker.getTypeAtLocation(expr.left);
      if (leftType.isStringLiteral()) {
        const key = leftType.value;
        const prop = rightType.getProperty(key);
        const apparentType = ctx.checker.getApparentType(rightType);
        const apparentProp = apparentType.getProperty(key);
        const has = !!(prop || apparentProp || (structFieldNames && structFieldNames.includes(key)));
        fctx.body.push({ op: "i32.const", value: has ? 1 : 0 });
        return { kind: "i32" };
      }

      // Fully dynamic — emit false as safe fallback
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
  }

  // ── Flatten long chains of same numeric operator ──
  // For expressions like a + b + c + d (left-recursive AST), flatten into an
  // iterative loop to avoid deep JS recursion and improve compilation speed.
  {
    const flatResult = tryFlattenBinaryChain(ctx, fctx, expr, op);
    if (flatResult !== null) return flatResult;
  }

  // ── Constant folding: emit a single constant when both operands are compile-time known ──
  {
    const folded = tryStaticToNumber(ctx, expr);
    if (folded !== undefined) {
      fctx.body.push({ op: "f64.const", value: folded });
      return { kind: "f64" };
    }
  }

  // Regular binary ops: evaluate both sides
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  const rightTsType = ctx.checker.getTypeAtLocation(expr.right);

  // ── Loose equality (== / !=) with mixed types ──
  // JS loose equality coerces types before comparing. Handle common cases:
  //   number == boolean / boolean == number → coerce boolean to number
  //   string == number / number == string → coerce string to number (parseFloat)
  //   string == boolean / boolean == string → coerce both to number
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  if (isLooseEq || isLooseNeq) {
    const leftIsNum = isNumberType(leftTsType);
    const leftIsBool = isBooleanType(leftTsType);
    const leftIsStr = isStringType(leftTsType);
    const rightIsNum = isNumberType(rightTsType);
    const rightIsBool = isBooleanType(rightTsType);
    const rightIsStr = isStringType(rightTsType);

    // number == boolean: coerce boolean (i32) → f64, then f64.eq
    if (leftIsNum && rightIsBool) {
      compileExpression(ctx, fctx, expr.left, { kind: "f64" });
      compileExpression(ctx, fctx, expr.right);
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
      return { kind: "i32" };
    }
    // boolean == number: coerce boolean (i32) → f64, then f64.eq
    if (leftIsBool && rightIsNum) {
      compileExpression(ctx, fctx, expr.left);
      fctx.body.push({ op: "f64.convert_i32_s" });
      compileExpression(ctx, fctx, expr.right, { kind: "f64" });
      fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
      return { kind: "i32" };
    }
    // string == number / number == string: coerce string to number via parseFloat
    if ((leftIsStr && rightIsNum) || (leftIsNum && rightIsStr)) {
      const pfIdx = ctx.funcMap.get("parseFloat");
      if (pfIdx !== undefined) {
        if (leftIsStr) {
          // left is string, right is number
          compileExpression(ctx, fctx, expr.left);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          compileExpression(ctx, fctx, expr.right, { kind: "f64" });
        } else {
          // left is number, right is string
          compileExpression(ctx, fctx, expr.left, { kind: "f64" });
          compileExpression(ctx, fctx, expr.right);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
        }
        fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
        return { kind: "i32" };
      }
    }
    // string == boolean / boolean == string: coerce both to number
    if ((leftIsStr && rightIsBool) || (leftIsBool && rightIsStr)) {
      const pfIdx = ctx.funcMap.get("parseFloat");
      if (pfIdx !== undefined) {
        if (leftIsStr) {
          compileExpression(ctx, fctx, expr.left);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
          compileExpression(ctx, fctx, expr.right);
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else {
          compileExpression(ctx, fctx, expr.left);
          fctx.body.push({ op: "f64.convert_i32_s" });
          compileExpression(ctx, fctx, expr.right);
          fctx.body.push({ op: "call", funcIdx: pfIdx });
        }
        fctx.body.push({ op: isLooseEq ? "f64.eq" : "f64.ne" });
        return { kind: "i32" };
      }
    }
  }

  // ── Any-typed operand dispatch ──
  // When both operands are `any`, use AnyValue dispatch ONLY for operators that
  // may have non-numeric semantics (+ can do string concat, equality needs type
  // awareness). For strictly numeric ops (-, *, /, %, **, comparisons, bitwise),
  // skip AnyValue and compile with a numeric hint so operands unbox to f64
  // directly, avoiding the overhead of AnyValue tag dispatch.
  if (ctx.anyValueTypeIdx >= 0) {
    const leftIsAny = (leftTsType.flags & ts.TypeFlags.Any) !== 0;
    const rightIsAny = (rightTsType.flags & ts.TypeFlags.Any) !== 0;
    if (leftIsAny && rightIsAny) {
      const isPlusOp = op === ts.SyntaxKind.PlusToken;
      const isEqualityOp =
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      // Only dispatch through AnyValue for + (string concat possible) and equality
      if (isPlusOp || isEqualityOp) {
        const anyDispatch = compileAnyBinaryDispatch(ctx, fctx, expr, op);
        if (anyDispatch !== null) return anyDispatch;
      }
      // For strictly numeric ops, fall through to compile with numeric hint
    }
  }

  // String operations — string triggers string concat for +, or string comparison when both strings
  const isRelational =
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken;
  // Equality ops involving a wrapper object (Number/String/Boolean) are not
  // simple string/number ops — they have object-identity / ToPrimitive
  // semantics. Route them through the externref/wrapper path below (#1111).
  const isEqualityOp =
    op === ts.SyntaxKind.EqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const leftIsWrapperObj = isWrapperObjectType(leftTsType);
  const rightIsWrapperObj = isWrapperObjectType(rightTsType);
  const wrapperEquality = isEqualityOp && (leftIsWrapperObj || rightIsWrapperObj);
  if (
    !wrapperEquality &&
    isStringType(leftTsType) &&
    (isStringType(rightTsType) ||
      op === ts.SyntaxKind.PlusToken ||
      (!isRelational && !isNumberType(rightTsType) && !isBooleanType(rightTsType) && !isBigIntType(rightTsType)))
  ) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }
  if (!wrapperEquality && op === ts.SyntaxKind.PlusToken && isStringType(rightTsType) && !isBigIntType(leftTsType)) {
    return compileStringBinaryOp(ctx, fctx, expr, op);
  }

  // BigInt operations — handle both pure bigint and mixed bigint/number cases
  if (isBigIntType(leftTsType) || isBigIntType(rightTsType)) {
    const leftIsBigInt = isBigIntType(leftTsType);
    const rightIsBigInt = isBigIntType(rightTsType);

    // Mixed BigInt + Number/String: comparison and equality operators (#227, #228, #295)
    if (leftIsBigInt !== rightIsBigInt) {
      const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;

      // Strict equality: BigInt and Number/String are different types → always false/true
      if (isStrictEq || isStrictNeq) {
        // Compile both sides for side effects, then drop them
        const lt = compileExpression(ctx, fctx, expr.left);
        if (lt) fctx.body.push({ op: "drop" });
        const rt = compileExpression(ctx, fctx, expr.right);
        if (rt) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }

      // Loose equality and comparisons: convert both operands to f64, then compare
      // For BigInt vs Number: i64 → f64 via f64.convert_i64_s
      // For BigInt vs String: string → f64 via parseFloat, i64 → f64 (#295)
      //   Incomparable strings (parseFloat returns NaN) make all comparisons false,
      //   which matches the JS spec for BigInt vs non-numeric-string.
      const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
      const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
      const isComparison =
        op === ts.SyntaxKind.LessThanToken ||
        op === ts.SyntaxKind.LessThanEqualsToken ||
        op === ts.SyntaxKind.GreaterThanToken ||
        op === ts.SyntaxKind.GreaterThanEqualsToken;

      if (isLooseEq || isLooseNeq || isComparison) {
        const leftIsStr = isStringType(leftTsType);
        const rightIsStr = isStringType(rightTsType);

        // Compile left operand
        const leftType = compileExpression(ctx, fctx, expr.left, leftIsBigInt ? { kind: "i64" } : undefined);
        if (!leftType) return null;
        // Convert left to f64
        if (leftType.kind === "i64") {
          fctx.body.push({ op: "f64.convert_i64_s" });
        } else if (leftType.kind === "externref") {
          // String/externref → f64 via parseFloat (NaN for incomparable strings)
          const pfIdx = ctx.funcMap.get("parseFloat");
          if (pfIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx });
          } else {
            addUnionImports(ctx);
            const unboxIdx = ctx.funcMap.get("__unbox_number")!;
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
        } else if (leftType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (leftType.kind === "ref" || leftType.kind === "ref_null") {
          // Object wrapper (e.g. Object(0n)) → coerce via valueOf (#997)
          coerceType(ctx, fctx, leftType, { kind: "f64" }, "number");
        }

        // Compile right operand
        const rightType = compileExpression(ctx, fctx, expr.right, rightIsBigInt ? { kind: "i64" } : undefined);
        if (!rightType) return null;
        // Convert right to f64
        if (rightType.kind === "i64") {
          fctx.body.push({ op: "f64.convert_i64_s" });
        } else if (rightType.kind === "externref") {
          // String/externref → f64 via parseFloat (NaN for incomparable strings)
          const pfIdx = ctx.funcMap.get("parseFloat");
          if (pfIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: pfIdx });
          } else {
            addUnionImports(ctx);
            const unboxIdx = ctx.funcMap.get("__unbox_number")!;
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          }
        } else if (rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (rightType.kind === "ref" || rightType.kind === "ref_null") {
          // Object wrapper (e.g. Object(0n)) → coerce via valueOf (#997)
          coerceType(ctx, fctx, rightType, { kind: "f64" }, "number");
        }

        // Emit f64 comparison
        if (isLooseEq) {
          fctx.body.push({ op: "f64.eq" });
        } else if (isLooseNeq) {
          fctx.body.push({ op: "f64.ne" });
        } else {
          return compileNumericBinaryOp(ctx, fctx, op, expr);
        }
        return { kind: "i32" };
      }

      // Mixed BigInt + Number arithmetic (e.g. 1n + 1): always a TypeError in JS.
      // Compile both sides for side effects, drop their values, then throw.
      const lt = compileExpression(ctx, fctx, expr.left);
      if (lt) fctx.body.push({ op: "drop" });
      const rt = compileExpression(ctx, fctx, expr.right);
      if (rt) fctx.body.push({ op: "drop" });
      emitThrowString(ctx, fctx, "Cannot mix BigInt and other types, use explicit conversions");
      return { kind: "i32" };
    }

    // Both operands are BigInt — compile as i64
    const i64Hint: ValType = { kind: "i64" };
    let leftType2 = compileExpression(ctx, fctx, expr.left, i64Hint);
    let rightType2 = compileExpression(ctx, fctx, expr.right, i64Hint);
    if (!leftType2 || !rightType2) return null;
    // Object(bigint) compiles to a struct ref, not i64. Coerce via valueOf (#997).
    const leftIsRef2 = leftType2.kind === "ref" || leftType2.kind === "ref_null";
    const rightIsRef2 = rightType2.kind === "ref" || rightType2.kind === "ref_null";
    if (leftIsRef2 || rightIsRef2) {
      // For strict equality: ref and i64 are never the same → always false/true
      const isStrictEq2 = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq2 = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (isStrictEq2 || isStrictNeq2) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq2 ? 1 : 0 });
        return { kind: "i32" };
      }
      // Coerce ref operands to f64 via valueOf, convert i64 to f64
      if (rightIsRef2) {
        coerceType(ctx, fctx, rightType2, { kind: "f64" }, "number");
        rightType2 = { kind: "f64" };
      }
      if (leftIsRef2) {
        const tmpR2 = allocTempLocal(fctx, rightType2);
        fctx.body.push({ op: "local.set", index: tmpR2 });
        coerceType(ctx, fctx, leftType2, { kind: "f64" }, "number");
        fctx.body.push({ op: "local.get", index: tmpR2 });
        releaseTempLocal(fctx, tmpR2);
        leftType2 = { kind: "f64" };
      }
      // Convert remaining i64 operand to f64
      if (rightType2.kind === "i64") {
        fctx.body.push({ op: "f64.convert_i64_s" });
      }
      if (leftType2.kind === "i64") {
        const tmpR3 = allocTempLocal(fctx, rightType2);
        fctx.body.push({ op: "local.set", index: tmpR3 });
        fctx.body.push({ op: "f64.convert_i64_s" });
        fctx.body.push({ op: "local.get", index: tmpR3 });
        releaseTempLocal(fctx, tmpR3);
      }
      return compileNumericBinaryOp(ctx, fctx, op, expr);
    }
    return compileI64BinaryOp(ctx, fctx, op, expr);
  }

  // Determine expected operand type from operator and context
  const isNumericOp =
    op === ts.SyntaxKind.PlusToken ||
    op === ts.SyntaxKind.MinusToken ||
    op === ts.SyntaxKind.AsteriskToken ||
    op === ts.SyntaxKind.AsteriskAsteriskToken ||
    op === ts.SyntaxKind.SlashToken ||
    op === ts.SyntaxKind.PercentToken ||
    op === ts.SyntaxKind.LessThanToken ||
    op === ts.SyntaxKind.LessThanEqualsToken ||
    op === ts.SyntaxKind.GreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanEqualsToken ||
    op === ts.SyntaxKind.AmpersandToken ||
    op === ts.SyntaxKind.BarToken ||
    op === ts.SyntaxKind.CaretToken ||
    op === ts.SyntaxKind.LessThanLessThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    op === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  // In fast mode, numeric hint is i32 (unless division/power which promotes to f64).
  // Also use i32 hint when operands have native i32 type annotations (type i32 = number).
  const isDivOrPow = op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.AsteriskAsteriskToken;
  const leftNativeType = resolveNativeTypeAnnotation(leftTsType);
  const rightNativeType = resolveNativeTypeAnnotation(rightTsType);
  const bothNativeI32 = leftNativeType?.kind === "i32" && rightNativeType?.kind === "i32";
  // Use i32 hint for relational comparisons where one operand is a known i32 local.
  // This avoids f64 conversion churn in for-loop conditions like `i < 10000` where
  // detectI32LoopVar already promoted the loop variable to i32.
  const isI32LocalRef = (e: ts.Expression): boolean => {
    if (!ts.isIdentifier(e)) return false;
    const idx = fctx.localMap.get(e.text);
    if (idx === undefined) return false;
    const entry = idx < fctx.params.length ? fctx.params[idx] : fctx.locals[idx - fctx.params.length];
    const type =
      entry && typeof entry === "object" && "type" in entry
        ? (entry as { type: ValType }).type
        : (entry as ValType | undefined);
    return type?.kind === "i32";
  };
  const hasI32LocalOperand = isRelational && !isDivOrPow && (isI32LocalRef(expr.left) || isI32LocalRef(expr.right));
  // #1120: when an arithmetic expression is the operand of `expr | 0`
  // (ToInt32 coercion), AND both operands are already i32 locals, hint
  // i32 so we emit native i32 arithmetic. The i32-overflow wrap is
  // semantically identical to f64 + ToInt32 here because the receiving
  // context is i32 by construction. This is what lets the iterative
  // Fibonacci body collapse to `i32.add` + `i32.add` + `local.set` in
  // the hot loop instead of the heavy f64-ToInt32 round-trip.
  //
  // #1179: extend to ANY bitwise op as parent (not just `| 0`) and to
  // recursive subtrees of i32-pure operands (literals, nested arith /
  // bitwise expressions on i32 leaves), and add a parallel i32 fast
  // path for bitwise ops themselves. Together these collapse the hot
  // body of `((i*17) ^ (i>>>3)) & 1023` to a clean i32 chain instead
  // of the per-op double-ToInt32 + f64 round-trip currently emitted.
  const isArithOp =
    op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.AsteriskToken;
  const isBitwiseOpKind = (k: ts.SyntaxKind): boolean =>
    k === ts.SyntaxKind.AmpersandToken ||
    k === ts.SyntaxKind.BarToken ||
    k === ts.SyntaxKind.CaretToken ||
    k === ts.SyntaxKind.LessThanLessThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanToken ||
    k === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
  // Skip past parens / `as` casts / non-null asserts when looking for the
  // enclosing context — `((a + b)) | 0` is the same shape as `(a + b) | 0`
  // for our purposes.
  let walk: ts.Node = expr;
  let parent: ts.Node | undefined = expr.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isNonNullExpression(parent))
  ) {
    walk = parent;
    parent = parent.parent;
  }
  // Parent ToInt32-coerces our result iff the parent is a bitwise op.
  // All bitwise ops apply ToInt32 to both operands per JS spec, so an
  // arith op nested inside a bitwise op can wrap mod 2^32 safely without
  // changing observable semantics. `| 0` is the canonical case but `^`,
  // `&`, `<<`, `>>`, `>>>` all share this property.
  const parentIsToInt32Bitwise =
    !!parent && ts.isBinaryExpression(parent) && isBitwiseOpKind(parent.operatorToken.kind);
  const wrappedInToInt32 = isArithOp && parentIsToInt32Bitwise;
  // Helper: peel parens/as/non-null wrappers off `e`.
  const peel = (e: ts.Expression): ts.Expression => {
    let inner: ts.Expression = e;
    while (
      ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isTypeAssertionExpression(inner) ||
      ts.isNonNullExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    return inner;
  };
  // #1179-followup: a "small" integer literal — magnitude strictly below 2^21.
  // Used to guard the i32 multiplication fast path (see `isI32MulSafe`).
  // The exact bound is `1 << 21` = 2097152; we accept |n| ≤ 2097151. Two
  // i32 values where one's magnitude is ≤ 2^21 produce a true product
  // bounded by 2^21 × 2^31 = 2^52 < 2^53, which is exactly representable
  // in f64. f64.mul of these inputs equals the true integer product, and
  // ToInt32 of the f64 result equals i32.mul of the inputs — so the i32
  // fast path matches the JS spec value bit-for-bit.
  const isSmallIntLit = (e: ts.Expression): boolean => {
    const inner = peel(e);
    if (!ts.isNumericLiteral(inner)) return false;
    const n = Number(inner.text.replace(/_/g, ""));
    return Number.isInteger(n) && Math.abs(n) < 1 << 21;
  };
  // #1179-followup: spec-faithful i32 multiplication is safe iff at least
  // one operand is provably small (|n| < 2^21). Without this guard the
  // i32.mul fast path can deviate from JS spec when the true integer
  // product exceeds 2^53 — f64 (53-bit mantissa) loses precision, so
  // f64.mul + ToInt32 disagrees with i32.mul on the low bits.
  // Example divergence: `(0x7FFFFFFF * 0x7FFFFFFF) | 0` is `0` per spec,
  // `1` via i32.mul. Guarding `*` with this check preserves the array-sum
  // win (`i * 17` etc. — the small-literal multiplier is the common case)
  // while restoring spec conformance for unbounded inputs.
  const isI32MulSafe = (l: ts.Expression, r: ts.Expression): boolean => {
    return isSmallIntLit(l) || isSmallIntLit(r);
  };
  // #1179: predicate for "this expression compiles to i32 cheaply with
  // an i32 hint" — leaves are i32 locals or i32-range integer literals,
  // and internal nodes are bitwise / `| 0` (always i32) or arithmetic
  // (i32 IF the result is ToInt32-wrapped, which our caller guarantees
  // by only invoking this from a bitwise / `| 0` context).
  //
  // #1179-followup: the multiplication arm is guarded by `isI32MulSafe`
  // — see comment on that helper for the rationale.
  const isI32PureExpr = (e: ts.Expression): boolean => {
    const inner = peel(e);
    if (ts.isIdentifier(inner)) return isI32LocalRef(inner);
    if (ts.isNumericLiteral(inner)) {
      const n = Number(inner.text.replace(/_/g, ""));
      return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
    }
    if (ts.isBinaryExpression(inner)) {
      const k = inner.operatorToken.kind;
      // `expr | 0` always produces i32 cleanly when its operand does.
      if (k === ts.SyntaxKind.BarToken && ts.isNumericLiteral(inner.right) && inner.right.text === "0") {
        return isI32PureExpr(inner.left);
      }
      // Bitwise ops always produce i32 (their own ToInt32 covers operands).
      if (isBitwiseOpKind(k)) {
        return isI32PureExpr(inner.left) && isI32PureExpr(inner.right);
      }
      // Arith add/sub: i32 wrap is correct under the parent's ToInt32
      // guarantee — f64 add/sub of two i32 values is exact (|a±b| ≤ 2^32
      // < 2^53), so ToInt32 of the f64 result equals i32.add/sub mod 2^32.
      if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
        return isI32PureExpr(inner.left) && isI32PureExpr(inner.right);
      }
      // Arith mul: i32 wrap is only spec-faithful when the true product
      // stays within 2^53. Without range tracking, the cheap proof is
      // "at least one operand is a small integer literal" — see
      // `isI32MulSafe`. Without this guard, large-input multiplications
      // would observably deviate from JS spec.
      if (k === ts.SyntaxKind.AsteriskToken) {
        return isI32PureExpr(inner.left) && isI32PureExpr(inner.right) && isI32MulSafe(inner.left, inner.right);
      }
    }
    return false;
  };
  // Arith op with ToInt32-wrapping parent: fire if both operands are i32-pure.
  // Subsumes the original i32-locals-only check; literals and nested chains now apply too.
  // #1179-followup: when the OUTER op is `*`, additionally require the
  // small-literal guard — same rationale as the recursive case above.
  const outerMulI32Safe = op !== ts.SyntaxKind.AsteriskToken || isI32MulSafe(expr.left, expr.right);
  const arithI32WithToInt32Wrap =
    wrappedInToInt32 && isI32PureExpr(expr.left) && isI32PureExpr(expr.right) && outerMulI32Safe;
  // Bitwise op with i32-pure operands: emit native i32 op directly,
  // skipping the f64-ToInt32 round-trip in compileBitwiseBinaryOp.
  const bitwiseI32 = isBitwiseOpKind(op) && isI32PureExpr(expr.left) && isI32PureExpr(expr.right);
  const numericHint: ValType | undefined = isNumericOp
    ? {
        kind:
          (ctx.fast || bothNativeI32 || hasI32LocalOperand || arithI32WithToInt32Wrap || bitwiseI32) && !isDivOrPow
            ? "i32"
            : "f64",
      }
    : undefined;

  let leftType = compileExpression(ctx, fctx, expr.left, numericHint);
  let rightType = compileExpression(ctx, fctx, expr.right, numericHint);

  if (!leftType || !rightType) return null;

  // Promote i32↔f64 mismatch (e.g. string.length:i32 !== 8:f64)
  if (leftType.kind === "i32" && rightType.kind === "f64") {
    const tmpR = allocTempLocal(fctx, { kind: "f64" });
    fctx.body.push({ op: "local.set", index: tmpR });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.get", index: tmpR });
    releaseTempLocal(fctx, tmpR);
    leftType = { kind: "f64" };
  } else if (leftType.kind === "f64" && rightType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    rightType = { kind: "f64" };
  }

  // ── Struct ref valueOf coercion (#138/#139) ──
  // When operands are struct refs (objects with valueOf), coerce them to f64
  // before performing numeric/comparison/equality operations.
  // For strict equality (===, !==): compare struct refs by reference identity.
  {
    const leftIsRef = leftType.kind === "ref" || leftType.kind === "ref_null";
    const rightIsRef = rightType.kind === "ref" || rightType.kind === "ref_null";
    if (leftIsRef || rightIsRef) {
      // Strict equality: reference identity comparison (no valueOf coercion)
      const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
      const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
      if (isStrictEq || isStrictNeq) {
        if (leftIsRef && rightIsRef) {
          fctx.body.push({ op: "ref.eq" });
          if (isStrictNeq) fctx.body.push({ op: "i32.eqz" });
          return { kind: "i32" };
        }
        // Strict equality with one ref and one primitive → always false (===) or true (!==)
        // since objects and primitives are different types in JS strict equality
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }

      // For numeric, comparison, and loose equality ops: coerce struct refs → f64 via valueOf
      if (isNumericOp || isEqOp || isNeqOp) {
        // Per JS spec, binary + uses ToPrimitive with hint "default",
        // while other numeric/comparison ops use hint "number".
        const hint: "number" | "default" = op === ts.SyntaxKind.PlusToken ? "default" : "number";
        // Coerce right operand (top of stack) first
        if (rightIsRef) {
          coerceType(ctx, fctx, rightType, { kind: "f64" }, hint);
          rightType = { kind: "f64" };
        }
        // Coerce left operand (below right on stack) — save right to local
        if (leftIsRef) {
          const tmpR = allocTempLocal(fctx, rightType);
          fctx.body.push({ op: "local.set", index: tmpR });
          coerceType(ctx, fctx, leftType, { kind: "f64" }, hint);
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        }
        // After valueOf coercion, one side may be f64 (from ref) and the other
        // may still be i32 (boolean/integer). Promote i32 → f64 to avoid type mismatch. (#433)
        if (leftType.kind === "i32" && rightType.kind === "f64") {
          const tmpR = allocTempLocal(fctx, { kind: "f64" });
          fctx.body.push({ op: "local.set", index: tmpR });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "local.get", index: tmpR });
          releaseTempLocal(fctx, tmpR);
          leftType = { kind: "f64" };
        } else if (leftType.kind === "f64" && rightType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
          rightType = { kind: "f64" };
        }
        // Now both operands are f64 — fall through to numeric dispatch below
      }
    }
  }

  // i32 numeric operations: fast mode, native type annotations, known i32 local
  // comparison, — #1120 — arithmetic of two i32 locals whose result is
  // ToInt32-coerced by an enclosing `| 0`, or — #1179 — a bitwise op with
  // i32-pure operands (skip the f64 round-trip entirely).
  if (
    leftType.kind === "i32" &&
    rightType.kind === "i32" &&
    ((ctx.fast && isNumberType(leftTsType)) ||
      bothNativeI32 ||
      hasI32LocalOperand ||
      arithI32WithToInt32Wrap ||
      bitwiseI32)
  ) {
    return compileI32BinaryOp(ctx, fctx, op, expr);
  }

  // i64 operations (bigint detected by compiled type, e.g. from variables)
  if (leftType.kind === "i64" && rightType.kind === "i64") {
    return compileI64BinaryOp(ctx, fctx, op, expr);
  }

  // Mixed i64/f64 (BigInt vs Number detected by compiled type) — convert i64 to f64 (#227, #228)
  if ((leftType.kind === "i64" && rightType.kind === "f64") || (leftType.kind === "f64" && rightType.kind === "i64")) {
    const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (isStrictEq || isStrictNeq) {
      // Different types → always false (===) or true (!==)
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
      return { kind: "i32" };
    }
    // Convert i64 operand to f64 — right is on top of stack
    if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else {
      // left is i64, need to swap: save right, convert left, restore right
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    // Now both are f64 — use numeric comparison
    const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
    const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
    if (isLooseEq) {
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    }
    if (isLooseNeq) {
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  if (
    (isNumberType(leftTsType) || leftType.kind === "f64") &&
    leftType.kind !== "externref" &&
    rightType.kind !== "externref"
  ) {
    // Ensure right operand is also f64 (may be i32 from boolean context)
    if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
  if (
    (isBooleanType(leftTsType) || leftType.kind === "i32") &&
    leftType.kind !== "externref" &&
    rightType.kind !== "externref"
  ) {
    // Ensure both operands are i32; if right is f64, promote left to f64 and use numeric path
    if (rightType.kind === "f64") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
      return compileNumericBinaryOp(ctx, fctx, op, expr);
    }
    // For arithmetic / bitwise ops on two i32 operands, use compileI32BinaryOp
    // which emits the matching i32 instruction (i32.add, i32.sub, …).
    // compileBooleanBinaryOp only handles comparison/equality — its `default:`
    // arm falls through silently on `+ - * %` etc., leaving both operands on
    // the stack with no combining op (#1211: caused recursive `f(n - 1)` in
    // any-typed fast-mode functions to be miscompiled into `f(1)` because the
    // TS-checker types the recursive param as `any`, so the i32-arith guard at
    // line ~1202 above (which requires `isNumberType(leftTsType)`) doesn't
    // fire and the dispatch falls into this branch instead).
    if (leftType.kind === "i32" && rightType.kind === "i32" && isNumericOp) {
      return compileI32BinaryOp(ctx, fctx, op, expr);
    }
    return compileBooleanBinaryOp(ctx, fctx, op);
  }

  // Externref in numeric context: unbox externref operands to f64
  if ((leftType.kind === "externref" || rightType.kind === "externref") && isNumericOp) {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number")!;
    if (rightType.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    }
    if (leftType.kind === "externref") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  // Externref equality: when either operand is a known string type, use
  // string content comparison instead of numeric unboxing (#225).
  // For strict equality (===, !==), cross-type comparisons always return false/true (#296).
  if ((leftType.kind === "externref" || rightType.kind === "externref") && (isEqOp || isNeqOp)) {
    const isStrict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    const leftIsString = isStringType(leftTsType);
    const rightIsString = isStringType(rightTsType);
    const leftIsNumber = isNumberType(leftTsType);
    const rightIsNumber = isNumberType(rightTsType);
    const leftIsBool = isBooleanType(leftTsType);
    const rightIsBool = isBooleanType(rightTsType);

    // Wrapper object semantics (#1111): `new Number(n)`, `new String(s)`,
    // `new Boolean(b)` are OBJECTS (typeof x === "object"), not primitives.
    // Strict equality between a wrapper and any primitive is always false.
    // Equality between two wrappers is reference identity.
    // Route through JS host == / === with NO numeric fallback so the answer
    // matches JS spec exactly (the numeric fallback below is only safe when
    // both operands are boxed primitives, not when either is a real JS object).
    const leftIsWrapper = isWrapperObjectType(leftTsType);
    const rightIsWrapper = isWrapperObjectType(rightTsType);
    if (leftIsWrapper || rightIsWrapper) {
      // Coerce operands to externref (right is on top of stack).
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      const hostFn = isStrict ? "__host_eq" : "__host_loose_eq";
      const hostIdx = ensureLateImport(ctx, hostFn, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      const finalHostIdx = ctx.funcMap.get(hostFn) ?? hostIdx;
      if (finalHostIdx === undefined) throw new Error(`Missing import after ensureLateImport: ${hostFn}`);
      fctx.body.push({ op: "call", funcIdx: finalHostIdx });
      if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
      return { kind: "i32" };
    }

    // Strict equality: different JS types → always false (===) or true (!==)
    if (isStrict) {
      const leftJsKind = leftIsString ? "string" : leftIsNumber ? "number" : leftIsBool ? "boolean" : "other";
      const rightJsKind = rightIsString ? "string" : rightIsNumber ? "number" : rightIsBool ? "boolean" : "other";
      if (leftJsKind !== "other" && rightJsKind !== "other" && leftJsKind !== rightJsKind) {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
        return { kind: "i32" };
      }
    }

    const eitherIsString = leftIsString || rightIsString;
    if (eitherIsString) {
      // Ensure both operands are externref before calling equals.
      // One side might be f64 (e.g. from a mistyped addition like new String("1") + new String("1"))
      // or i32 (from boolean). Coerce non-externref operands to externref first.
      if (rightType.kind !== "externref") {
        coerceType(ctx, fctx, rightType, { kind: "externref" });
      }
      if (leftType.kind !== "externref") {
        const tmpR = allocTempLocal(fctx, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: tmpR });
        coerceType(ctx, fctx, leftType, { kind: "externref" });
        fctx.body.push({ op: "local.get", index: tmpR });
        releaseTempLocal(fctx, tmpR);
      }
      addStringImports(ctx);
      const equalsIdx = ctx.jsStringImports.get("equals");
      if (equalsIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: equalsIdx });
        if (isNeqOp) fctx.body.push({ op: "i32.eqz" });
        return { kind: "i32" };
      }
    }

    // Reference identity fast-path for externref equality.
    // When both operands are externref (e.g. objects stored as any), check if they
    // are the same GC reference before falling back to numeric unboxing.
    // This fixes `var a = {}; var b = a; a === b` which was incorrectly returning false
    // because numeric unboxing of objects produces NaN, and NaN !== NaN.
    // Uses any.convert_extern to get anyref, then ref.test/ref.cast to eqref for ref.eq.
    // The eq abstract heap type is encoded as -19 in signed LEB128 (= 0x6d).
    const EQ_HEAP_TYPE = -19;
    if (
      leftType.kind === "externref" &&
      rightType.kind === "externref" &&
      !leftIsString &&
      !rightIsString &&
      !leftIsNumber &&
      !rightIsNumber &&
      !leftIsBool &&
      !rightIsBool
    ) {
      // Save both externrefs to temp locals for potential reuse in numeric fallback
      const tmpRight = allocTempLocal(fctx, { kind: "externref" });
      const tmpLeft = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: tmpRight });
      fctx.body.push({ op: "local.set", index: tmpLeft });

      // Convert left to anyref and test if it's an eqref (GC ref)
      fctx.body.push({ op: "local.get", index: tmpLeft });
      fctx.body.push({ op: "any.convert_extern" });
      const tmpAnyLeft = allocTempLocal(fctx, { kind: "anyref" });
      fctx.body.push({ op: "local.tee", index: tmpAnyLeft });
      fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Left is eqref-compatible — check right too
          { op: "local.get", index: tmpRight },
          { op: "any.convert_extern" },
          ...(() => {
            const tmpAnyRight = allocTempLocal(fctx, { kind: "anyref" });
            const instrs: Instr[] = [
              { op: "local.tee", index: tmpAnyRight },
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  // Both are eqref — cast and compare with ref.eq
                  { op: "local.get", index: tmpAnyLeft },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "local.get", index: tmpAnyRight },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "ref.eq" },
                ],
                else: [
                  // Right is not eqref — cannot be equal to a GC ref
                  { op: "i32.const", value: 0 },
                ],
              },
            ];
            releaseTempLocal(fctx, tmpAnyRight);
            return instrs;
          })(),
        ],
        else: [
          // Left is not eqref — fall through to numeric comparison
          // by pushing -1 as sentinel to indicate "not handled"
          { op: "i32.const", value: -1 },
        ],
      });
      releaseTempLocal(fctx, tmpAnyLeft);

      // Check if the identity comparison produced a definitive result (0 or 1)
      // vs the sentinel -1 (meaning we need numeric fallback)
      const identityResult = allocTempLocal(fctx, { kind: "i32" });
      fctx.body.push({ op: "local.tee", index: identityResult });
      fctx.body.push({ op: "i32.const", value: -1 });
      fctx.body.push({ op: "i32.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // Identity check produced 0 or 1 — use it directly
          // For != / !==, negate
          { op: "local.get", index: identityResult },
          ...(isNeqOp ? [{ op: "i32.eqz" } as Instr] : []),
        ],
        else: (() => {
          // Host equality fallback — two host externrefs (e.g. functions
          // like `Array === Array`) are not WasmGC eqrefs, so ref.eq cannot
          // compare them. For strict equality, `__host_eq` calls JS `===`.
          // For loose equality, `__host_loose_eq` calls JS `==` which
          // handles null==undefined and type coercion per §7.2.15. (#1065, #1134)
          addUnionImports(ctx);
          const unboxIdx = ctx.funcMap.get("__unbox_number")!;
          if (isStrict) {
            // Strict equality: __host_eq (JS ===) for reference identity.
            // If that returns false, fall through to numeric unboxing for
            // boxed numbers that differ in identity but have the same value. (#1065)
            const hostEqIdx = ensureLateImport(
              ctx,
              "__host_eq",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            return [
              { op: "local.get", index: tmpLeft },
              { op: "local.get", index: tmpRight },
              { op: "call", funcIdx: hostEqIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: isNeqOp ? 0 : 1 } as Instr],
                else: [
                  { op: "local.get", index: tmpLeft },
                  { op: "call", funcIdx: unboxIdx },
                  { op: "local.get", index: tmpRight },
                  { op: "call", funcIdx: unboxIdx },
                  { op: isEqOp ? "f64.eq" : "f64.ne" } as Instr,
                ] as Instr[],
              } as Instr,
            ] as Instr[];
          } else {
            // Loose equality: __host_loose_eq (JS ==) handles all coercion
            // rules including null==undefined per §7.2.15. The result is
            // definitive — no numeric fallback needed. (#1134)
            const hostLooseEqIdx = ensureLateImport(
              ctx,
              "__host_loose_eq",
              [{ kind: "externref" }, { kind: "externref" }],
              [{ kind: "i32" }],
            );
            flushLateImportShifts(ctx, fctx);
            return [
              { op: "local.get", index: tmpLeft },
              { op: "local.get", index: tmpRight },
              { op: "call", funcIdx: hostLooseEqIdx } as Instr,
              ...(isNeqOp ? [{ op: "i32.eqz" } as Instr] : []),
            ] as Instr[];
          }
        })(),
      });
      releaseTempLocal(fctx, identityResult);
      releaseTempLocal(fctx, tmpRight);
      releaseTempLocal(fctx, tmpLeft);
      return { kind: "i32" };
    }

    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number")!;
    // Coerce/unbox right side (top of stack) to f64
    if (rightType.kind === "externref") {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    }
    // Coerce/unbox left side (below right on stack) to f64
    if (leftType.kind === "externref") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    } else if (leftType.kind === "i32") {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    fctx.body.push({ op: isEqOp ? "f64.eq" : "f64.ne" });
    return { kind: "i32" };
  }

  // ── Fallback: coerce remaining type mismatches to f64 for numeric ops ──
  // When operand types don't match any specific path above (e.g. ref + externref,
  // i64 + externref, or other ambiguous combos), try to coerce both to f64.
  if (isNumericOp) {
    // Coerce right operand (top of stack) to f64
    if (rightType.kind === "externref") {
      addUnionImports(ctx);
      const unboxIdx = ctx.funcMap.get("__unbox_number")!;
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else if (rightType.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
    } else if (rightType.kind === "i64") {
      fctx.body.push({ op: "f64.convert_i64_s" });
    } else if (rightType.kind === "ref" || rightType.kind === "ref_null") {
      coerceType(ctx, fctx, rightType, { kind: "f64" });
    }
    // Coerce left operand (below right on stack) — save right to local
    if (
      leftType.kind === "externref" ||
      leftType.kind === "i32" ||
      leftType.kind === "i64" ||
      leftType.kind === "ref" ||
      leftType.kind === "ref_null"
    ) {
      const tmpR = allocTempLocal(fctx, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: tmpR });
      if (leftType.kind === "externref") {
        addUnionImports(ctx);
        const unboxIdx = ctx.funcMap.get("__unbox_number")!;
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
      } else if (leftType.kind === "i32") {
        fctx.body.push({ op: "f64.convert_i32_s" });
      } else if (leftType.kind === "i64") {
        fctx.body.push({ op: "f64.convert_i64_s" });
      } else if (leftType.kind === "ref" || leftType.kind === "ref_null") {
        coerceType(ctx, fctx, leftType, { kind: "f64" });
      }
      fctx.body.push({ op: "local.get", index: tmpR });
      releaseTempLocal(fctx, tmpR);
    }
    return compileNumericBinaryOp(ctx, fctx, op, expr);
  }

  reportError(ctx, expr, `Unsupported binary operator for type`);
  return null;
}

/**
 * Compile a binary expression where both operands are `any`-typed.
 * Emits both operands as ref $AnyValue and calls the appropriate __any_* helper.
 */
function compileAnyBinaryDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult {
  // Map operator to helper name and result type
  let helperName: string | null = null;
  let resultIsI32 = false; // true for comparison/equality operators

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      helperName = "__any_add";
      break;
    case ts.SyntaxKind.MinusToken:
      helperName = "__any_sub";
      break;
    case ts.SyntaxKind.AsteriskToken:
      helperName = "__any_mul";
      break;
    case ts.SyntaxKind.SlashToken:
      helperName = "__any_div";
      break;
    case ts.SyntaxKind.PercentToken:
      helperName = "__any_mod";
      break;
    case ts.SyntaxKind.EqualsEqualsToken:
      helperName = "__any_eq";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      helperName = "__any_strict_eq";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.ExclamationEqualsToken:
      helperName = "__any_eq";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      helperName = "__any_strict_eq";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.LessThanToken:
      helperName = "__any_lt";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.GreaterThanToken:
      helperName = "__any_gt";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      helperName = "__any_le";
      resultIsI32 = true;
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      helperName = "__any_ge";
      resultIsI32 = true;
      break;
    default:
      return null; // Not a supported operator for any dispatch
  }

  ensureAnyHelpers(ctx);
  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // Compile both operands. The helpers (`__any_add`, `__any_eq`, …) all take
  // `(ref null $AnyValue, ref null $AnyValue)` parameters, so any operand
  // that didn't naturally produce an AnyValue must be boxed before the call.
  // Without this coercion, recursive `any`-typed functions whose body
  // contains `f(...) + f(...)` validate as "call param types must match"
  // because the recursive call returns f64 (or i32) while the helper
  // expects ref $AnyValue (#1211).
  const anyValueTarget: ValType = { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return null;
  if (!isAnyValue(leftType, ctx)) {
    coerceType(ctx, fctx, leftType, anyValueTarget);
  }
  const rightType = compileExpression(ctx, fctx, expr.right);
  if (!rightType) return null;
  if (!isAnyValue(rightType, ctx)) {
    coerceType(ctx, fctx, rightType, anyValueTarget);
  }

  fctx.body.push({ op: "call", funcIdx });

  // For != / !==, negate the __any_eq result
  if (op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    fctx.body.push({ op: "i32.eqz" });
  }

  if (resultIsI32) {
    return { kind: "i32" };
  }
  return { kind: "ref", typeIdx: ctx.anyValueTypeIdx };
}

export function compileNumericBinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "f64.add" });
      return { kind: "f64" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "f64.sub" });
      return { kind: "f64" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "f64.mul" });
      return { kind: "f64" };
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      const funcIdx = ctx.funcMap.get("Math_pow");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return { kind: "f64" };
      }
      reportError(ctx, expr, "Math_pow import not found for ** operator");
      return { kind: "f64" };
    }
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "f64.div" });
      return { kind: "f64" };
    case ts.SyntaxKind.PercentToken:
      return compileModulo(ctx, fctx, expr);
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "f64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "f64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "f64.lt" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "f64.le" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "f64.gt" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "f64.ge" });
      return { kind: "i32" };
    case ts.SyntaxKind.AmpersandToken:
      return compileBitwiseBinaryOp(fctx, "i32.and", false);
    case ts.SyntaxKind.BarToken:
      return compileBitwiseBinaryOp(fctx, "i32.or", false);
    case ts.SyntaxKind.CaretToken:
      return compileBitwiseBinaryOp(fctx, "i32.xor", false);
    case ts.SyntaxKind.LessThanLessThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shl", false);
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shr_s", false);
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return compileBitwiseBinaryOp(fctx, "i32.shr_u", true);
    default:
      reportError(ctx, expr, `Unsupported numeric binary operator: ${ts.SyntaxKind[op]}`);
      return { kind: "f64" };
  }
}

/** Fast mode: i32 arithmetic/comparison on two i32 operands */
function compileI32BinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "i32.add" });
      return { kind: "i32" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "i32.sub" });
      return { kind: "i32" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "i32.mul" });
      return { kind: "i32" };
    case ts.SyntaxKind.PercentToken:
      fctx.body.push({ op: "i32.rem_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i32.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i32.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i32.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i32.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i32.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i32.ge_s" });
      return { kind: "i32" };
    // Bitwise — direct i32 ops (no conversion needed!)
    case ts.SyntaxKind.AmpersandToken:
      fctx.body.push({ op: "i32.and" });
      return { kind: "i32" };
    case ts.SyntaxKind.BarToken:
      fctx.body.push({ op: "i32.or" });
      return { kind: "i32" };
    case ts.SyntaxKind.CaretToken:
      fctx.body.push({ op: "i32.xor" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanLessThanToken:
      fctx.body.push({ op: "i32.shl" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      fctx.body.push({ op: "i32.shr_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      fctx.body.push({ op: "i32.shr_u" });
      return { kind: "i32" };
    default:
      // Fall back to f64 path for division, power, etc.
      return compileNumericBinaryOp(ctx, fctx, op, expr);
  }
}

/** BigInt: i64 arithmetic/comparison on two i64 operands */
function compileI64BinaryOp(
  ctx: CodegenContext,
  fctx: FunctionContext,
  op: ts.SyntaxKind,
  expr: ts.BinaryExpression,
): ValType {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      fctx.body.push({ op: "i64.add" });
      return { kind: "i64" };
    case ts.SyntaxKind.MinusToken:
      fctx.body.push({ op: "i64.sub" });
      return { kind: "i64" };
    case ts.SyntaxKind.AsteriskToken:
      fctx.body.push({ op: "i64.mul" });
      return { kind: "i64" };
    case ts.SyntaxKind.SlashToken:
      fctx.body.push({ op: "i64.div_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.PercentToken:
      fctx.body.push({ op: "i64.rem_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.AsteriskAsteriskToken: {
      // BigInt exponentiation: base ** exp implemented as a loop
      // Stack: [base: i64, exp: i64] → [result: i64]
      const expLocal = allocTempLocal(fctx, { kind: "i64" });
      const baseLocal = allocTempLocal(fctx, { kind: "i64" });
      const resultLocal = allocTempLocal(fctx, { kind: "i64" });
      // Save exponent (top of stack), then base
      fctx.body.push({ op: "local.set", index: expLocal });
      fctx.body.push({ op: "local.set", index: baseLocal });
      // result = 1
      fctx.body.push({ op: "i64.const", value: 1n });
      fctx.body.push({ op: "local.set", index: resultLocal });
      // block $break { loop $continue {
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if exp <= 0 then break
              { op: "local.get", index: expLocal },
              { op: "i64.const", value: 0n },
              { op: "i64.le_s" },
              { op: "br_if", depth: 1 }, // break out of block
              // result = result * base
              { op: "local.get", index: resultLocal },
              { op: "local.get", index: baseLocal },
              { op: "i64.mul" },
              { op: "local.set", index: resultLocal },
              // exp = exp - 1
              { op: "local.get", index: expLocal },
              { op: "i64.const", value: 1n },
              { op: "i64.sub" },
              { op: "local.set", index: expLocal },
              // continue loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      });
      // Push result
      fctx.body.push({ op: "local.get", index: resultLocal });
      releaseTempLocal(fctx, expLocal);
      releaseTempLocal(fctx, baseLocal);
      releaseTempLocal(fctx, resultLocal);
      return { kind: "i64" };
    }
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i64.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i64.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i64.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i64.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i64.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i64.ge_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.AmpersandToken:
      fctx.body.push({ op: "i64.and" });
      return { kind: "i64" };
    case ts.SyntaxKind.BarToken:
      fctx.body.push({ op: "i64.or" });
      return { kind: "i64" };
    case ts.SyntaxKind.CaretToken:
      fctx.body.push({ op: "i64.xor" });
      return { kind: "i64" };
    case ts.SyntaxKind.LessThanLessThanToken:
      fctx.body.push({ op: "i64.shl" });
      return { kind: "i64" };
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      fctx.body.push({ op: "i64.shr_s" });
      return { kind: "i64" };
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      fctx.body.push({ op: "i64.shr_u" });
      return { kind: "i64" };
    default:
      reportError(ctx, expr, `Unsupported BigInt binary operator: ${ts.SyntaxKind[op]}`);
      return { kind: "i64" };
  }
}

/**
 * Emit JS ToInt32: reduce f64 modulo 2^32 then truncate to i32.
 * Handles NaN→0, Infinity→0, and large values that wrap.
 * Stack: [f64] → [i32]
 */
export function emitToInt32(fctx: FunctionContext): void {
  // JS ToInt32 algorithm:
  //   if NaN/Infinity/0 → 0
  //   n = sign(x) * floor(abs(x))
  //   int32bit = n mod 2^32
  //   if int32bit >= 2^31 → int32bit - 2^32
  //
  // In wasm: x - floor(x / 2^32) * 2^32, then trunc_sat
  // For values in i32 range, trunc_sat alone works. We only need the
  // modulo reduction for out-of-range values.
  // Step 1: truncate fractional part toward zero (JS ToInt32 does this first)
  // Step 2: x - floor(x / 2^32) * 2^32 → maps to [0, 2^32)
  // Step 3: trunc_sat_f64_u gives correct bit pattern
  // NaN/Infinity: trunc(NaN)=NaN, Inf-Inf=NaN, trunc_sat_u(NaN)=0. Correct.
  fctx.body.push({ op: "f64.trunc" });
  const tmp = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.div" });
  fctx.body.push({ op: "f64.floor" });
  fctx.body.push({ op: "f64.const", value: 4294967296 });
  fctx.body.push({ op: "f64.mul" });
  fctx.body.push({ op: "f64.sub" });
  fctx.body.push({ op: "i32.trunc_sat_f64_u" });
  releaseTempLocal(fctx, tmp);
}

/** Truncate two f64 operands to i32 via ToInt32, apply an i32 bitwise op, convert back to f64 */
function compileBitwiseBinaryOp(
  fctx: FunctionContext,
  i32op: "i32.and" | "i32.or" | "i32.xor" | "i32.shl" | "i32.shr_s" | "i32.shr_u",
  unsigned: boolean,
): ValType {
  // Stack: [left_f64, right_f64]
  const tmpR = allocTempLocal(fctx, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: tmpR });
  emitToInt32(fctx);
  fctx.body.push({ op: "local.get", index: tmpR });
  releaseTempLocal(fctx, tmpR);
  emitToInt32(fctx);
  fctx.body.push({ op: i32op });
  fctx.body.push({ op: unsigned ? "f64.convert_i32_u" : "f64.convert_i32_s" });
  return { kind: "f64" };
}

function compileModulo(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  emitModulo(fctx);
  return { kind: "f64" };
}

/**
 * Emit JS remainder (a % b) with correct IEEE 754 edge cases.
 * Stack: [a_f64, b_f64] -> [result_f64]
 *
 * Edge cases handled:
 * - x % Infinity = x (when x is finite)
 * - -0 % x = -0 (sign of zero preserved via f64.copysign)
 * - Infinity % x = NaN, x % 0 = NaN, NaN % x = NaN (handled naturally by formula)
 */
export function emitModulo(fctx: FunctionContext): void {
  const tmpB = allocTempLocal(fctx, { kind: "f64" });
  const tmpA = allocTempLocal(fctx, { kind: "f64" });

  fctx.body.push({ op: "local.set", index: tmpB });
  fctx.body.push({ op: "local.set", index: tmpA });

  // Build the "then" branch: b is infinite and a is finite → result is a
  const thenInstrs: Instr[] = [{ op: "local.get", index: tmpA }];

  // Build the "else" branch: standard formula a - trunc(a/b) * b with copysign
  const elseInstrs: Instr[] = [
    { op: "local.get", index: tmpA },
    { op: "local.get", index: tmpA },
    { op: "local.get", index: tmpB },
    { op: "f64.div" },
    { op: "f64.trunc" }, // JS % uses truncation toward zero, not floor
    { op: "local.get", index: tmpB },
    { op: "f64.mul" },
    { op: "f64.sub" },
    // Preserve sign of dividend for zero results (-0 % x should be -0)
    { op: "local.get", index: tmpA },
    { op: "f64.copysign" },
  ];

  // Check: if |b| == Infinity and a is finite, result is a; else standard formula
  fctx.body.push({ op: "local.get", index: tmpB });
  fctx.body.push({ op: "f64.abs" });
  fctx.body.push({ op: "f64.const", value: Infinity });
  fctx.body.push({ op: "f64.eq" });
  fctx.body.push({ op: "local.get", index: tmpA });
  fctx.body.push({ op: "f64.abs" });
  fctx.body.push({ op: "f64.const", value: Infinity });
  fctx.body.push({ op: "f64.ne" });
  fctx.body.push({ op: "i32.and" });
  // Use if/then/else to select between Infinity shortcut and standard formula
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: thenInstrs,
    else: elseInstrs,
  });
  releaseTempLocal(fctx, tmpA);
  releaseTempLocal(fctx, tmpB);
}

function compileBooleanBinaryOp(ctx: CodegenContext, fctx: FunctionContext, op: ts.SyntaxKind): ValType {
  switch (op) {
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      fctx.body.push({ op: "i32.eq" });
      return { kind: "i32" };
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      fctx.body.push({ op: "i32.ne" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanToken:
      fctx.body.push({ op: "i32.lt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.LessThanEqualsToken:
      fctx.body.push({ op: "i32.le_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanToken:
      fctx.body.push({ op: "i32.gt_s" });
      return { kind: "i32" };
    case ts.SyntaxKind.GreaterThanEqualsToken:
      fctx.body.push({ op: "i32.ge_s" });
      return { kind: "i32" };
    default:
      return { kind: "i32" };
  }
}
