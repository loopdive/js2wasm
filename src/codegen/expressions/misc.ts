/**
 * Miscellaneous expression compilation: conditionals, generators/yield,
 * struct name resolution, and static analysis helpers.
 */
import ts from "typescript";
import {
  isGeneratorType,
  isIteratorResultType,
  isNumberType,
  isStringType,
  isBooleanType,
  isVoidType,
  mapTsTypeToWasm,
} from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import {
  addFuncType,
  addImport,
  addStringConstantGlobal,
  addUnionImports,
  ensureExnTag,
  ensureI32Condition,
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  isAnyValue,
  localGlobalIdx,
} from "../index.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "../context/locals.js";
import { pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileExpression, coerceType, valTypesMatch, VOID_RESULT } from "../shared.js";
import type { InnerResult } from "../shared.js";
import { coerceType as coerceTypeImpl, defaultValueInstrs, pushDefaultValue } from "../type-coercion.js";
import { ensureLateImport, flushLateImportShifts, emitUndefined } from "./late-imports.js";
import { emitThrowString, isEffectivelyVoidReturn } from "./helpers.js";
import {
  compileElementAccess,
  compilePropertyAccess,
  emitBoundsGuardedArraySet,
  emitNullCheckThrow,
  emitNullGuardedStructGet,
  isProvablyNonNull,
  typeErrorThrowInstrs,
  resolveStructName,
  isGeneratorIteratorResultLike,
  getIteratorResultValueType,
} from "../property-access.js";

// Re-export for backward compatibility — these helpers now live in property-access.ts.
export { resolveStructName, isGeneratorIteratorResultLike, getIteratorResultValueType };

function compileConditionalExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ConditionalExpression,
): ValType | null {
  const condType = compileExpression(ctx, fctx, expr.condition);
  if (!condType) {
    // void condition — JS treats undefined as falsy, so push i32.const 0
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    ensureI32Condition(fctx, condType, ctx);
  }

  const savedBody = pushBody(fctx);
  const thenResultType = compileExpression(ctx, fctx, expr.whenTrue);
  // If the then-branch is void (no value on stack), push a default value
  // so the ternary has a consistent result. JS treats void as undefined → NaN for numbers.
  if (!thenResultType) {
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  let thenInstrs = fctx.body;

  fctx.body = [];
  const elseResultType = compileExpression(ctx, fctx, expr.whenFalse);
  if (!elseResultType) {
    fctx.body.push({ op: "f64.const", value: NaN });
  }
  let elseInstrs = fctx.body;

  fctx.body = savedBody;

  const thenType: ValType = thenResultType ?? { kind: "f64" };
  const elseType: ValType = elseResultType ?? { kind: "f64" };

  // Determine the common result type for both branches
  let resultValType: ValType = thenType;

  const sameKind = thenType.kind === elseType.kind;
  const sameRefIdx =
    sameKind &&
    (thenType.kind === "ref" || thenType.kind === "ref_null") &&
    (thenType as { typeIdx: number }).typeIdx === (elseType as { typeIdx: number }).typeIdx;

  if (!sameKind || ((thenType.kind === "ref" || thenType.kind === "ref_null") && !sameRefIdx)) {
    // Types differ — find a common type and coerce both branches
    if ((thenType.kind === "i32" || thenType.kind === "f64") && (elseType.kind === "i32" || elseType.kind === "f64")) {
      // Both numeric — coerce to f64
      resultValType = { kind: "f64" };
    } else if (
      (thenType.kind === "ref" || thenType.kind === "ref_null") &&
      (elseType.kind === "ref" || elseType.kind === "ref_null") &&
      isAnyValue(thenType, ctx) === isAnyValue(elseType, ctx)
    ) {
      // Both refs but different typeIdx — use ref_null of the then type
      resultValType =
        thenType.kind === "ref"
          ? {
              kind: "ref_null",
              typeIdx: (thenType as { typeIdx: number }).typeIdx,
            }
          : thenType;
    } else {
      // Fallback: coerce both to externref
      resultValType = { kind: "externref" };
    }

    // Coerce then-branch to the common type
    if (!valTypesMatch(thenType, resultValType)) {
      const coerceBody: Instr[] = [];
      fctx.body = coerceBody;
      coerceType(ctx, fctx, thenType, resultValType);
      fctx.body = savedBody;
      thenInstrs = [...thenInstrs, ...coerceBody];
    }

    // Coerce else-branch to the common type
    if (!valTypesMatch(elseType, resultValType)) {
      const coerceBody: Instr[] = [];
      fctx.body = coerceBody;
      coerceType(ctx, fctx, elseType, resultValType);
      fctx.body = savedBody;
      elseInstrs = [...elseInstrs, ...coerceBody];
    }
  } else {
    // Same type — just pass the then-type through
    resultValType = thenType;
  }

  // Conditional results must be nullable — either branch could produce null
  if (resultValType.kind === "ref") {
    resultValType = {
      kind: "ref_null",
      typeIdx: (resultValType as { typeIdx: number }).typeIdx,
    };
  }

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultValType },
    then: thenInstrs,
    else: elseInstrs,
  });

  return resultValType;
}

// ── Optional chaining ────────────────────────────────────────────────

/**
 * Optional property access: obj?.prop
 * Compiles obj, checks if null → returns null, else accesses property normally.
 */
// Object/array/tuple/symbol literal compilation has been extracted to ./literals.ts (#688 step 7).

// Object.defineProperty flag helpers, compileObjectDefineProperty,
// compileObjectKeysOrValues, and compilePropertyIntrospection have been
// extracted to ./object-ops.ts (#688 step 6).

// resolveStructName, isGeneratorIteratorResultLike, getIteratorResultValueType have been
// moved to property-access.ts (re-exported above for backward compatibility).

// ── Generator yield expression ────────────────────────────────────────

/**
 * Compile a `yield expr` expression inside a generator function.
 * Pushes the yielded value into the __gen_buffer (a JS array managed by the host).
 * The yield expression itself evaluates to void (we don't support receiving
 * values via yield in this initial implementation).
 */
function compileYieldExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.YieldExpression): InnerResult {
  // Ensure we're inside a generator function
  if (!fctx.isGenerator) {
    reportError(ctx, expr, "yield expression outside of generator function");
    return null;
  }

  // Get the buffer local
  const bufferIdx = fctx.localMap.get("__gen_buffer");
  if (bufferIdx === undefined) {
    reportError(ctx, expr, "Internal error: __gen_buffer not found in generator function");
    return null;
  }

  if (!expr.expression) {
    // yield with no value: push undefined
    const pushRefIdx = ctx.funcMap.get("__gen_push_ref");
    if (pushRefIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: bufferIdx });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "call", funcIdx: pushRefIdx });
    }
    // In the eager generator model, yield always "receives" undefined from .next().
    // Push ref.null extern so callers that use yield as an expression get a value.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  // Compile the yielded expression
  const yieldedType = compileExpression(ctx, fctx, expr.expression);
  if (yieldedType === null) {
    // Even if the yielded expression produced nothing, yield itself is an
    // expression that returns the value from .next() — push undefined.
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" } as ValType;
  }

  // Store the yielded value in a temp local, then push to buffer
  const tmpLocal = allocLocal(fctx, `__yield_tmp_${fctx.locals.length}`, yieldedType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Push to buffer based on type
  fctx.body.push({ op: "local.get", index: bufferIdx });
  fctx.body.push({ op: "local.get", index: tmpLocal });

  if (yieldedType.kind === "f64") {
    const pushIdx = ctx.funcMap.get("__gen_push_f64");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  } else if (yieldedType.kind === "i32") {
    const pushIdx = ctx.funcMap.get("__gen_push_i32");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  } else {
    // externref, ref, ref_null — all pass as externref
    const pushIdx = ctx.funcMap.get("__gen_push_ref");
    if (pushIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: pushIdx });
    }
  }

  // In the eager generator model, yield always "receives" undefined from .next().
  // Push ref.null extern so callers that use yield as an expression get a value.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" } as ValType;
}

/** Check if an expression is statically known to be NaN at compile time */
/**
 * Try to statically determine the numeric value of an expression.
 * Handles: numeric literals, NaN, Infinity, -Infinity, object-with-valueOf, {}.
 * Returns undefined if the value cannot be determined at compile time.
 */
export function tryStaticToNumber(ctx: CodegenContext, expr: ts.Expression): number | undefined {
  // Numeric literal
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  // String literal → ToNumber: "" → 0, "123" → 123, "abc" → NaN
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return Number(expr.text);
  // null → 0
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 0;
  // undefined → NaN
  if (ts.isIdentifier(expr) && expr.text === "undefined") return NaN;
  // true → 1, false → 0
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
  // NaN identifier
  if (ts.isIdentifier(expr) && expr.text === "NaN") return NaN;
  // Infinity identifier
  if (ts.isIdentifier(expr) && expr.text === "Infinity") return Infinity;
  // -Infinity: prefix minus on Infinity
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    const inner = tryStaticToNumber(ctx, expr.operand);
    if (inner !== undefined) return -inner;
  }
  // Binary expressions: fold constant operands at compile time
  if (ts.isBinaryExpression(expr)) {
    // Don't fold string + anything as numeric — JS semantics requires string concat
    if (
      expr.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      (ts.isStringLiteral(expr.left) ||
        ts.isNoSubstitutionTemplateLiteral(expr.left) ||
        ts.isStringLiteral(expr.right) ||
        ts.isNoSubstitutionTemplateLiteral(expr.right))
    ) {
      return undefined;
    }
    const left = tryStaticToNumber(ctx, expr.left);
    const right = tryStaticToNumber(ctx, expr.right);
    if (left !== undefined && right !== undefined) {
      switch (expr.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken: {
          // For +, check if either operand is a string type in TS.
          // If so, + is string concatenation, not numeric addition,
          // and we cannot fold to a number.
          const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
          const rightTsType = ctx.checker.getTypeAtLocation(expr.right);
          if (isStringType(leftTsType) || isStringType(rightTsType)) return undefined;
          return left + right;
        }
        case ts.SyntaxKind.MinusToken:
          return left - right;
        case ts.SyntaxKind.AsteriskToken:
          return left * right;
        case ts.SyntaxKind.SlashToken:
          return right !== 0 ? left / right : undefined;
        case ts.SyntaxKind.PercentToken:
          return right !== 0 ? left % right : undefined;
        case ts.SyntaxKind.AsteriskAsteriskToken:
          return left ** right;
        case ts.SyntaxKind.AmpersandToken:
          return left & right;
        case ts.SyntaxKind.BarToken:
          return left | right;
        case ts.SyntaxKind.CaretToken:
          return left ^ right;
        case ts.SyntaxKind.LessThanLessThanToken:
          return left << right;
        case ts.SyntaxKind.GreaterThanGreaterThanToken:
          return left >> right;
        case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
          return left >>> right;
        default:
          break; // non-numeric binary op, fall through
      }
    }
  }
  // Property access on string literals: "hello".length → 5
  if (ts.isPropertyAccessExpression(expr) && expr.name.text === "length") {
    const obj = expr.expression;
    if (ts.isStringLiteral(obj) || ts.isNoSubstitutionTemplateLiteral(obj)) {
      return obj.text.length;
    }
    // Also resolve through const variables: const s = "hello"; s.length → 5
    if (ts.isIdentifier(obj)) {
      const sym = ctx.checker.getSymbolAtLocation(obj);
      const decl = sym?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = decl.initializer;
        if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
          return init.text.length;
        }
      }
    }
  }
  // Object literal: check valueOf, then toString per ToPrimitive spec (#866)
  // Only fold when we can fully statically resolve the return value.
  // If valueOf/toString have side effects (throw, etc.), bail out to runtime.
  if (ts.isObjectLiteralExpression(expr)) {
    // Empty object literal {} → ToNumber({}) = NaN per spec
    if (expr.properties.length === 0) return NaN;
    // Try valueOf first (hint "number")
    const valueOfProp = expr.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "valueOf",
    );
    if (valueOfProp && ts.isPropertyAssignment(valueOfProp)) {
      const init = valueOfProp.initializer;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        // Check if valueOf returns a non-primitive (object/array) — ToPrimitive
        // falls through to toString in that case, so we can't use valueOf's result
        const returnExpr = getReturnExpression(init);
        if (returnExpr && (ts.isObjectLiteralExpression(returnExpr) || ts.isArrayLiteralExpression(returnExpr))) {
          // valueOf returns a non-primitive → fall through to toString
        } else {
          const retVal = getStaticReturnValue(ctx, init);
          if (retVal !== undefined) return retVal;
          // valueOf exists but can't be statically resolved (may throw, have side effects)
          // → bail out to runtime, don't fold
          return undefined;
        }
      } else {
        // valueOf is not a function literal → can't fold
        return undefined;
      }
    }
    // No valueOf → try toString (ToPrimitive fallback per JS spec)
    const toStringProp = expr.properties.find(
      (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "toString",
    );
    if (toStringProp && ts.isPropertyAssignment(toStringProp)) {
      const init = toStringProp.initializer;
      if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) {
        const retVal = getStaticReturnValue(ctx, init);
        if (retVal !== undefined) return retVal;
        // toString exists but can't be statically resolved → bail to runtime
        return undefined;
      }
      // toString is not a function literal → can't fold
      return undefined;
    }
    // No valueOf or toString → NaN (spec: ToNumber({}) = NaN)
    return NaN;
  }
  // Parenthesized expression: unwrap parentheses
  if (ts.isParenthesizedExpression(expr)) {
    return tryStaticToNumber(ctx, expr.expression);
  }
  // Unary + (ToNumber coercion): +expr
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.PlusToken) {
    return tryStaticToNumber(ctx, expr.operand);
  }
  // Variable: trace to initializer (only for const declarations to avoid
  // incorrectly folding mutable variables like `let heapSize = 0`)
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      const declList = decl.parent;
      if (ts.isVariableDeclarationList(declList) && (declList.flags & ts.NodeFlags.Const) !== 0) {
        return tryStaticToNumber(ctx, decl.initializer);
      }
    }
  }
  return undefined;
}

/** Get the static numeric return value of a simple function (single return statement) */
function getStaticReturnValue(ctx: CodegenContext, fn: ts.FunctionExpression | ts.ArrowFunction): number | undefined {
  const body = fn.body;
  if (!ts.isBlock(body)) {
    // Arrow with expression body: () => 42
    return tryStaticToNumber(ctx, body);
  }
  // Look for a single return statement
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) {
      return tryStaticToNumber(ctx, stmt.expression);
    }
  }
  return undefined;
}

/** Get the return expression of a simple function (single return statement) */
function getReturnExpression(fn: ts.FunctionExpression | ts.ArrowFunction): ts.Expression | undefined {
  const body = fn.body;
  if (!ts.isBlock(body)) return body; // arrow expression body
  for (const stmt of body.statements) {
    if (ts.isReturnStatement(stmt) && stmt.expression) return stmt.expression;
  }
  return undefined;
}

function isStaticNaN(ctx: CodegenContext, expr: ts.Expression): boolean {
  // NaN identifier
  if (ts.isIdentifier(expr) && expr.text === "NaN") return true;
  // 0 / 0, 0.0 / 0.0
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.SlashToken &&
    ts.isNumericLiteral(expr.left) &&
    Number(expr.left.text) === 0 &&
    ts.isNumericLiteral(expr.right) &&
    Number(expr.right.text) === 0
  )
    return true;
  // Variable initialized with NaN: trace to declaration
  if (ts.isIdentifier(expr)) {
    const sym = ctx.checker.getSymbolAtLocation(expr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      return isStaticNaN(ctx, decl.initializer);
    }
  }
  return false;
}

export { compileConditionalExpression, compileYieldExpression, isStaticNaN };
