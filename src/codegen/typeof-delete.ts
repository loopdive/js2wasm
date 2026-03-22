/**
 * typeof, delete, instanceof, and RegExp literal compilation.
 * Extracted from expressions.ts (issue #688 step 5).
 */
import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import { allocLocal, allocTempLocal, releaseTempLocal, resolveWasmType, addUnionImports, parseRegExpLiteral, isAnyValue, ensureAnyHelpers } from "./index.js";
import {
  isNumberType,
  isBooleanType,
  isStringType,
  isSymbolType,
} from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { compileExpression, getLine, getCol } from "./shared.js";
import type { InnerResult } from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { resolveStructName } from "./expressions.js";

// ── Delete expression ─────────────────────────────────────────────────

/**
 * Emit the sentinel (undefined) value for a given Wasm field type.
 * - ref/ref_null: ref.null of the struct's type index
 * - externref: ref.null.extern
 * - f64: NaN (chosen as sentinel since deleted numeric props return undefined -> NaN in numeric context)
 * - i32: 0
 */
function emitDeleteSentinel(fctx: FunctionContext, fieldType: ValType): void {
  switch (fieldType.kind) {
    case "ref":
    case "ref_null":
      fctx.body.push({ op: "ref.null", typeIdx: (fieldType as { typeIdx: number }).typeIdx });
      break;
    case "externref":
      fctx.body.push({ op: "ref.null.extern" });
      break;
    case "f64":
      fctx.body.push({ op: "f64.const", value: NaN });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    default:
      fctx.body.push({ op: "ref.null.extern" });
      break;
  }
}

/**
 * Compile `delete expr`.
 * - `delete obj.prop` / `delete obj[key]`: set the field to a sentinel (undefined) value, return true
 * - `delete identifier`: return false (i32 0) — variables are not deletable
 * - `delete otherExpr`: compile for side effects, drop, return true (i32 1)
 *
 * WasmGC struct fields cannot be removed at runtime, so we simulate deletion
 * by setting the field to a sentinel value (ref.null for ref types, NaN for f64).
 * Property reads of ref.null / NaN naturally produce undefined-like behavior.
 */
export function compileDeleteExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
): InnerResult {
  const operand = expr.expression;

  // Unwrap parenthesized/type-assertion wrappers to find the underlying expression
  let inner: ts.Expression = operand;
  while (ts.isParenthesizedExpression(inner) || ts.isAsExpression(inner) ||
         ts.isNonNullExpression(inner) || ts.isTypeAssertionExpression(inner)) {
    inner = ts.isParenthesizedExpression(inner) ? inner.expression :
            ts.isAsExpression(inner) ? inner.expression :
            ts.isNonNullExpression(inner) ? inner.expression :
            (inner as ts.TypeAssertion).expression;
  }

  if (ts.isIdentifier(inner)) {
    // Variables are not deletable — return false
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Try to resolve struct type and field for property access: delete obj.prop
  if (ts.isPropertyAccessExpression(inner)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = ts.isPrivateIdentifier(inner.name) ? inner.name.text.slice(1) : inner.name.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          // Compile the object expression, then set field to sentinel
          compileExpression(ctx, fctx, inner.expression);
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
      }
    }
  }

  // Try to resolve struct type and field for element access: delete obj["prop"]
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteral(inner.argumentExpression)) {
    const objType = ctx.checker.getTypeAtLocation(inner.expression);
    let typeName = resolveStructName(ctx, objType);
    if (!typeName && ts.isIdentifier(inner.expression)) {
      typeName = ctx.widenedVarStructMap.get(inner.expression.text);
    }
    if (typeName) {
      const structTypeIdx = ctx.structMap.get(typeName);
      const fields = ctx.structFields.get(typeName);
      const fieldName = inner.argumentExpression.text;
      if (structTypeIdx !== undefined && fields) {
        const fieldIdx = fields.findIndex((f) => f.name === fieldName);
        if (fieldIdx !== -1 && fields[fieldIdx]!.mutable) {
          const fieldType = fields[fieldIdx]!.type;
          compileExpression(ctx, fctx, inner.expression);
          emitDeleteSentinel(fctx, fieldType);
          fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx });
          fctx.body.push({ op: "i32.const", value: 1 });
          return { kind: "i32" };
        }
      }
    }
  }

  // For property access / element access / other expressions:
  // compile the operand for side effects, drop, return true
  const operandType = compileExpression(ctx, fctx, operand);
  if (operandType !== null) {
    fctx.body.push({ op: "drop" });
  }
  fctx.body.push({ op: "i32.const", value: 1 });
  return { kind: "i32" };
}

// ── RegExp literal ────────────────────────────────────────────────────

/**
 * Compile a RegExp literal (e.g. /\d+/g) by desugaring it to new RegExp(pattern, flags).
 * The pattern and flags strings are loaded from the string pool, then RegExp_new is called.
 */
export function compileRegExpLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): ValType | null {
  const { pattern, flags } = parseRegExpLiteral(expr.getText());

  // Load pattern string
  const patternResult = compileStringLiteral(ctx, fctx, pattern, expr);
  if (!patternResult) return null;

  // Load flags string (or ref.null.extern if no flags)
  if (flags) {
    const flagsResult = compileStringLiteral(ctx, fctx, flags, expr);
    if (!flagsResult) return null;
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }

  // Call RegExp_new(pattern, flags) -> externref
  const funcIdx = ctx.funcMap.get("RegExp_new");
  if (funcIdx === undefined) {
    ctx.errors.push({
      message: "Missing RegExp_new import for regex literal",
      line: getLine(expr),
      column: getCol(expr),
    });
    return null;
  }
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

// ── instanceof ────────────────────────────────────────────────────────

/**
 * Collect all class tags that are "instanceof-compatible" with the given class:
 * the class itself plus all its descendants (transitive children).
 */
function collectInstanceOfTags(ctx: CodegenContext, className: string): number[] {
  const ownTag = ctx.classTagMap.get(className);
  if (ownTag === undefined) return [];
  const tags = [ownTag];
  // Walk classParentMap to find all children (classes whose parent is className)
  for (const [child, parent] of ctx.classParentMap) {
    if (parent === className) {
      tags.push(...collectInstanceOfTags(ctx, child));
    }
  }
  return tags;
}

/**
 * Resolve the class name from the right operand of an instanceof expression.
 * Handles identifiers, class expressions, and arbitrary expressions via the type checker.
 */
function resolveInstanceOfClassName(
  ctx: CodegenContext,
  rightExpr: ts.Expression,
): string | undefined {
  // Direct identifier: `x instanceof Foo`
  if (ts.isIdentifier(rightExpr)) {
    const name = rightExpr.text;
    // Check direct name first, then classExprNameMap
    if (ctx.classTagMap.has(name)) return name;
    const mapped = ctx.classExprNameMap.get(name);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    // Fall through to type checker
  }

  // Use the TypeScript type checker to resolve the type of the right operand
  const tsType = ctx.checker.getTypeAtLocation(rightExpr);
  // For class constructors, get the construct signatures' return type
  const constructSigs = tsType.getConstructSignatures?.();
  if (constructSigs && constructSigs.length > 0) {
    const instanceType = constructSigs[0]!.getReturnType();
    const symbolName = instanceType.getSymbol()?.name;
    if (symbolName) {
      if (ctx.classTagMap.has(symbolName)) return symbolName;
      const mapped = ctx.classExprNameMap.get(symbolName);
      if (mapped && ctx.classTagMap.has(mapped)) return mapped;
    }
  }

  // Try the symbol name directly (for class expressions assigned to variables)
  const symbolName = tsType.getSymbol()?.name;
  if (symbolName) {
    if (ctx.classTagMap.has(symbolName)) return symbolName;
    const mapped = ctx.classExprNameMap.get(symbolName);
    if (mapped && ctx.classTagMap.has(mapped)) return mapped;
  }

  return undefined;
}

/**
 * Compile `expr instanceof ClassName`.
 * Reads the hidden __tag field (index 0) from the struct and compares
 * it against the class's compile-time tag value (and all descendant tags
 * for class hierarchy support).
 */
export function compileInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  // Resolve the right operand class name (supports identifiers, expressions, class expressions)
  const className = resolveInstanceOfClassName(ctx, expr.right);
  if (className === undefined) {
    // Cannot resolve the class — emit false (i32.const 0) as a graceful fallback
    // We still need to compile the left operand for side effects, then drop it
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Collect all compatible tags (this class + all descendants)
  const compatibleTags = collectInstanceOfTags(ctx, className);
  if (compatibleTags.length === 0) {
    // No tags found — emit false
    const leftType = compileExpression(ctx, fctx, expr.left);
    if (leftType) {
      fctx.body.push({ op: "drop" });
    }
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // Compile left operand (the value to test) — must be a ref to a class struct
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (!leftType) return null;

  // Resolve the struct type index for the right-side class (the target we test against)
  const rightStructTypeIdx = ctx.structMap.get(className);

  // Find the root ancestor of the right class (for casting externref values)
  let rootClass = className;
  while (ctx.classParentMap.has(rootClass)) {
    rootClass = ctx.classParentMap.get(rootClass)!;
  }
  const rootStructTypeIdx = ctx.structMap.get(rootClass) ?? rightStructTypeIdx;

  // --- Handle externref left operand (any type) ---
  // When the left operand is externref, we cannot do struct.get directly.
  // Convert externref -> anyref, try to cast to the root struct type,
  // then read the __tag field and compare against compatible tags.
  // We use ref.test first to avoid trapping on non-struct values (null, primitives).
  if (leftType.kind === "externref") {
    if (rootStructTypeIdx === undefined) {
      // Cannot resolve any struct type — drop and emit false
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }

    // Convert externref -> anyref, store in local
    fctx.body.push({ op: "any.convert_extern" });
    const anyLocalIdx = allocTempLocal(fctx, { kind: "anyref" });
    fctx.body.push({ op: "local.set", index: anyLocalIdx });

    // Build the "then" branch: value is NOT a struct of the right root type -> false
    const thenBody: Instr[] = [
      { op: "i32.const", value: 0 },
    ];

    // Build the "else" branch: value IS a struct -> read __tag and compare
    const elseBody: Instr[] = [
      { op: "local.get", index: anyLocalIdx },
      { op: "ref.cast", typeIdx: rootStructTypeIdx },
      { op: "struct.get", typeIdx: rootStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      elseBody.push({ op: "local.set", index: tagLocalIdx });
      elseBody.push({ op: "local.get", index: tagLocalIdx });
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        elseBody.push({ op: "local.get", index: tagLocalIdx });
        elseBody.push({ op: "i32.const", value: compatibleTags[i]! });
        elseBody.push({ op: "i32.eq" });
        elseBody.push({ op: "i32.or" });
      }
    }

    // Emit: (local.get $any) (ref.test (ref $rootStruct))
    //        (if (result i32) (then i32.const 0) (else ...read tag...))
    // Note: ref.test returns 0 for non-struct values and null, 1 for matching struct.
    // We invert the condition: if ref.test FAILS -> 0, if PASSES -> check tag.
    fctx.body.push({ op: "local.get", index: anyLocalIdx });
    fctx.body.push({ op: "ref.test", typeIdx: rootStructTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: elseBody,   // ref.test passed -> check tag
      else: thenBody,    // ref.test failed -> false
    });
    releaseTempLocal(fctx, anyLocalIdx);

    return { kind: "i32" };
  }

  // --- Handle i32 or f64 left operand (primitive types) ---
  // Primitives are never instances of a class — drop and emit false
  if (leftType.kind === "i32" || leftType.kind === "f64") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Resolve the struct type index from the left operand's type ---
  const leftTsType = ctx.checker.getTypeAtLocation(expr.left);
  let leftClassName = leftTsType.getSymbol()?.name;
  if (leftClassName && !ctx.structMap.has(leftClassName)) {
    leftClassName = ctx.classExprNameMap.get(leftClassName) ?? leftClassName;
  }
  let leftStructTypeIdx = leftClassName ? ctx.structMap.get(leftClassName) : undefined;

  // If the left operand type is not directly resolvable, try to find any struct
  // that could be the base type. For union types or 'any', we try the right class's struct.
  if (leftStructTypeIdx === undefined) {
    leftStructTypeIdx = rootStructTypeIdx;
  }

  if (leftStructTypeIdx === undefined) {
    // Still cannot resolve — drop left value and emit false
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  // --- Handle nullable ref (ref_null) — null instanceof X must be false ---
  // For nullable refs, emit: if (ref.is_null) then 0 else (tag check)
  const isNullable = leftType.kind === "ref_null";
  if (isNullable) {
    // Store the ref in a local so we can test it for null and re-use it
    const refLocalIdx = allocLocal(fctx, `__instanceof_ref_${fctx.locals.length}`, leftType);
    fctx.body.push({ op: "local.set", index: refLocalIdx });

    // Build the "then" branch (null case -> false)
    const thenBody: Instr[] = [
      { op: "i32.const", value: 0 },
    ];

    // Build the "else" branch (non-null case -> read tag and compare)
    const elseBody: Instr[] = [
      { op: "local.get", index: refLocalIdx },
      { op: "ref.cast", typeIdx: leftStructTypeIdx },
      { op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 },
    ];

    if (compatibleTags.length === 1) {
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
    } else {
      const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
      elseBody.push({ op: "local.set", index: tagLocalIdx });
      elseBody.push({ op: "local.get", index: tagLocalIdx });
      elseBody.push({ op: "i32.const", value: compatibleTags[0]! });
      elseBody.push({ op: "i32.eq" });
      for (let i = 1; i < compatibleTags.length; i++) {
        elseBody.push({ op: "local.get", index: tagLocalIdx });
        elseBody.push({ op: "i32.const", value: compatibleTags[i]! });
        elseBody.push({ op: "i32.eq" });
        elseBody.push({ op: "i32.or" });
      }
    }

    // Emit: (local.get $ref) (ref.is_null) (if (result i32) (then ...) (else ...))
    fctx.body.push({ op: "local.get", index: refLocalIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: thenBody,
      else: elseBody,
    });

    return { kind: "i32" };
  }

  // --- Non-nullable ref path: read __tag field directly ---
  // Read the __tag field (field index 0) from the struct
  fctx.body.push({ op: "struct.get", typeIdx: leftStructTypeIdx, fieldIdx: 0 });

  if (compatibleTags.length === 1) {
    // Simple case: exact match only (no subclasses)
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });
  } else {
    // Multiple tags: emit (tag == t1) || (tag == t2) || ...
    // We need to store the tag value in a local to avoid re-reading it
    const tagLocalIdx = allocLocal(fctx, `__instanceof_tag_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "local.set", index: tagLocalIdx });

    // First comparison
    fctx.body.push({ op: "local.get", index: tagLocalIdx });
    fctx.body.push({ op: "i32.const", value: compatibleTags[0]! });
    fctx.body.push({ op: "i32.eq" });

    // Remaining comparisons, OR'd together
    for (let i = 1; i < compatibleTags.length; i++) {
      fctx.body.push({ op: "local.get", index: tagLocalIdx });
      fctx.body.push({ op: "i32.const", value: compatibleTags[i]! });
      fctx.body.push({ op: "i32.eq" });
      fctx.body.push({ op: "i32.or" });
    }
  }

  return { kind: "i32" };
}

// ── typeof ────────────────────────────────────────────────────────────

/**
 * Compile `typeof x` as a standalone expression that returns a type string (externref).
 * For statically known types, emits the string constant directly.
 * For externref/union types, calls the __typeof host helper.
 */
export function compileTypeofExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.TypeOfExpression,
): ValType | null {
  const operand = expr.expression;

  // typeof Math.<constant> -> "number", typeof Math.<method> -> "function"
  if (ts.isPropertyAccessExpression(operand) &&
      ts.isIdentifier(operand.expression) &&
      operand.expression.text === "Math") {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    if (mathConstants.has(operand.name.text)) {
      return compileStringLiteral(ctx, fctx, "number");
    }
    return compileStringLiteral(ctx, fctx, "function");
  }

  // typeof import.meta -> "object"
  if (ts.isMetaProperty(operand) &&
      operand.keywordToken === ts.SyntaxKind.ImportKeyword &&
      operand.name.text === "meta") {
    return compileStringLiteral(ctx, fctx, "object");
  }

  // typeof new.target -> "function" inside constructors, "undefined" outside
  if (ts.isMetaProperty(operand) &&
      operand.keywordToken === ts.SyntaxKind.NewKeyword &&
      operand.name.text === "target") {
    if (fctx.isConstructor) {
      return compileStringLiteral(ctx, fctx, "function");
    } else {
      return compileStringLiteral(ctx, fctx, "undefined");
    }
  }

  const tsType = ctx.checker.getTypeAtLocation(operand);

  // Handle null and undefined before wasm type mapping, since they map
  // to externref/i32 which would give wrong typeof results.
  if (tsType.flags & ts.TypeFlags.Null) {
    return compileStringLiteral(ctx, fctx, "object");
  }
  if (tsType.flags & ts.TypeFlags.Undefined || tsType.flags & ts.TypeFlags.Void) {
    return compileStringLiteral(ctx, fctx, "undefined");
  }

  const wasmType = resolveWasmType(ctx, tsType);

  // For statically known types, emit the constant string directly.
  // The type-name strings are pre-registered by collectStringLiterals.
  if (wasmType.kind === "f64") {
    return compileStringLiteral(ctx, fctx, "number");
  }
  if (wasmType.kind === "i32") {
    // Determine if this is boolean, symbol, or number (i32 is used for all three)
    if (isSymbolType(tsType)) {
      return compileStringLiteral(ctx, fctx, "symbol");
    }
    if (isBooleanType(tsType)) {
      return compileStringLiteral(ctx, fctx, "boolean");
    }
    // i32 used as number (e.g. void, but unlikely in typeof)
    return compileStringLiteral(ctx, fctx, "number");
  }
  if (wasmType.kind === "ref" || wasmType.kind === "ref_null") {
    // Fast mode: any-typed operand -> runtime typeof via __any_typeof
    if (ctx.fast && isAnyValue(wasmType, ctx)) {
      ensureAnyHelpers(ctx);
      const typeofIdx = ctx.funcMap.get("__any_typeof");
      if (typeofIdx !== undefined) {
        const operandType = compileExpression(ctx, fctx, operand);
        if (operandType === null) return null;
        fctx.body.push({ op: "call", funcIdx: typeofIdx });
        return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      }
    }
    // Check if the TS type is callable (function/arrow/class) — typeof should return "function"
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    // Also check construct signatures — classes have typeof "function"
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    return compileStringLiteral(ctx, fctx, "object");
  }

  // For externref: check if the TS type is statically known as string
  if (isStringType(tsType)) {
    return compileStringLiteral(ctx, fctx, "string");
  }

  // For externref types: check call/construct signatures for function types
  if (wasmType.kind === "externref") {
    const callSigs = tsType.getCallSignatures?.();
    if (callSigs && callSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    const ctorSigs = tsType.getConstructSignatures?.();
    if (ctorSigs && ctorSigs.length > 0) {
      return compileStringLiteral(ctx, fctx, "function");
    }
    // If the TS type is a known object type (not any/unknown), resolve statically
    if (tsType.flags & ts.TypeFlags.Object) {
      return compileStringLiteral(ctx, fctx, "object");
    }
  }

  // For union/unknown externref types, call the __typeof host helper at runtime
  addUnionImports(ctx);
  const funcIdx = ctx.funcMap.get("__typeof");
  if (funcIdx === undefined) return null;

  // Compile the operand to push its value onto the stack
  const operandType = compileExpression(ctx, fctx, operand);
  if (operandType === null) return null;

  // Coerce to externref if needed (e.g. f64 -> boxed number)
  if (operandType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  } else if (operandType.kind === "i32") {
    const boxIdx = ctx.funcMap.get("__box_boolean");
    if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
  }

  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}

/**
 * Compile `typeof x === "number"` / `typeof x !== "string"` etc.
 * Returns i32 result, or null if the expression is not a typeof comparison.
 */
export function compileTypeofComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  const op = expr.operatorToken.kind;
  const isEq =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
    op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  // Detect typeof on left or right
  let typeofExpr: ts.TypeOfExpression | null = null;
  let stringLiteral: string | null = null;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    stringLiteral = expr.right.text;
  } else if (ts.isTypeOfExpression(expr.right) && ts.isStringLiteral(expr.left)) {
    typeofExpr = expr.right;
    stringLiteral = expr.left.text;
  }

  if (!typeofExpr || !stringLiteral) return null;

  // Static resolution: if the typeof result is known at compile time,
  // emit a constant comparison result without any runtime call.
  const operand = typeofExpr.expression;
  const tsType = ctx.checker.getTypeAtLocation(operand);
  let staticTypeof: string | null = null;
  // Math.<constant> -> "number", Math.<method> -> "function"
  if (ts.isPropertyAccessExpression(operand) &&
      ts.isIdentifier(operand.expression) &&
      operand.expression.text === "Math") {
    const mathConstants = new Set(["PI", "E", "LN2", "LN10", "SQRT2", "SQRT1_2", "LOG2E", "LOG10E"]);
    staticTypeof = mathConstants.has(operand.name.text) ? "number" : "function";
  } else if (tsType.flags & ts.TypeFlags.Null) {
    staticTypeof = "object";
  } else if (tsType.flags & ts.TypeFlags.Undefined || tsType.flags & ts.TypeFlags.Void) {
    staticTypeof = "undefined";
  } else {
    const wasmType = resolveWasmType(ctx, tsType);
    if (wasmType.kind === "f64") staticTypeof = "number";
    else if (wasmType.kind === "i32") staticTypeof = isSymbolType(tsType) ? "symbol" : isBooleanType(tsType) ? "boolean" : "number";
    else if ((wasmType.kind === "ref" || wasmType.kind === "ref_null") && !isAnyValue(wasmType, ctx)) {
      const callSigs = tsType.getCallSignatures?.();
      const ctorSigs2 = tsType.getConstructSignatures?.();
      staticTypeof = (callSigs && callSigs.length > 0) || (ctorSigs2 && ctorSigs2.length > 0) ? "function" : "object";
    }
    else if (isStringType(tsType)) staticTypeof = "string";
    else if (wasmType.kind === "externref") {
      const callSigs = tsType.getCallSignatures?.();
      const ctorSigs2 = tsType.getConstructSignatures?.();
      if ((callSigs && callSigs.length > 0) || (ctorSigs2 && ctorSigs2.length > 0)) {
        staticTypeof = "function";
      } else if (tsType.flags & ts.TypeFlags.Object) {
        staticTypeof = "object";
      }
    }
  }
  if (staticTypeof !== null) {
    const matches = staticTypeof === stringLiteral;
    const result = isEq ? (matches ? 1 : 0) : (matches ? 0 : 1);
    fctx.body.push({ op: "i32.const", value: result });
    return { kind: "i32" };
  }

  // Any-typed typeof comparison via tag check
  // Instead of calling __any_typeof + string comparison, we can directly check the tag
  // on the $AnyValue struct. This avoids pulling in the full native string helpers.
  if (isAnyValue(resolveWasmType(ctx, tsType), ctx)) {
    ensureAnyHelpers(ctx);
    // Map the string literal to tag check(s)
    let tagChecks: number[] | null = null;
    if (stringLiteral === "number") tagChecks = [2, 3]; // i32 or f64
    else if (stringLiteral === "boolean") tagChecks = [4];
    else if (stringLiteral === "string") tagChecks = [5, 6]; // externref string or gcref string
    else if (stringLiteral === "undefined") tagChecks = [1];
    else if (stringLiteral === "object") tagChecks = [0]; // null -> "object"

    if (tagChecks !== null) {
      // Compile the operand
      const operandType = compileExpression(ctx, fctx, operand);
      if (!operandType) return null;
      // Get the tag field
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 0 });
      // Check if tag matches any of the expected values
      if (tagChecks.length === 1) {
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
      } else {
        // Multiple tags: (tag == t1) || (tag == t2)
        const tagLocal = allocTempLocal(fctx, { kind: "i32" });
        fctx.body.push({ op: "local.set", index: tagLocal });
        fctx.body.push({ op: "local.get", index: tagLocal });
        fctx.body.push({ op: "i32.const", value: tagChecks[0]! });
        fctx.body.push({ op: "i32.eq" });
        for (let i = 1; i < tagChecks.length; i++) {
          fctx.body.push({ op: "local.get", index: tagLocal });
          fctx.body.push({ op: "i32.const", value: tagChecks[i]! });
          fctx.body.push({ op: "i32.eq" });
          fctx.body.push({ op: "i32.or" });
        }
        releaseTempLocal(fctx, tagLocal);
      }
      if (isNeq) {
        fctx.body.push({ op: "i32.eqz" });
      }
      return { kind: "i32" };
    }
  }

  // Ensure union imports are registered
  addUnionImports(ctx);

  // Determine the helper function name
  let helperName: string | null = null;
  if (stringLiteral === "number") helperName = "__typeof_number";
  else if (stringLiteral === "string") helperName = "__typeof_string";
  else if (stringLiteral === "boolean") helperName = "__typeof_boolean";

  if (!helperName) return null;

  const funcIdx = ctx.funcMap.get(helperName);
  if (funcIdx === undefined) return null;

  // Compile the operand of typeof — need to get the raw externref value
  // The operand should be loaded without narrowing (use the declared type)
  if (ts.isIdentifier(operand)) {
    const localIdx = fctx.localMap.get(operand.text);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    } else {
      // Try other resolution paths
      const valType = compileExpression(ctx, fctx, operand);
      if (!valType) return null;
    }
  } else {
    const valType = compileExpression(ctx, fctx, operand);
    if (!valType) return null;
  }

  // Call the typeof helper
  fctx.body.push({ op: "call", funcIdx });

  // If !== comparison, negate the result
  if (isNeq) {
    fctx.body.push({ op: "i32.eqz" });
  }

  return { kind: "i32" };
}
