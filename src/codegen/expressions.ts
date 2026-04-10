/**
 * Expression compilation dispatcher.
 *
 * This file is the public interface for expression compilation.
 * All heavy implementations live in the sub-modules under ./expressions/.
 * This dispatcher:
 *   1. Re-exports the public API from sub-modules (preserving external consumers)
 *   2. Provides the top-level compileExpression / compileExpressionBody / compileExpressionInner
 *      dispatcher (depth guard, fast-paths, coercion)
 *   3. Provides emitCoercedLocalSet and coerceType (used by statements and index)
 *   4. Registers delegates in shared.ts (registerCompileExpression, etc.)
 */
import ts from "typescript";
import { mapTsTypeToWasm, isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureAnyHelpers, isAnyValue } from "./shared.js";
import type { InnerResult } from "./shared.js";
import {
  getCol,
  getLine,
  registerCompileExpression,
  registerEnsureLateImport,
  registerFlushLateImportShifts,
  valTypesMatch,
  VOID_RESULT,
} from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "./type-coercion.js";

// ── Sub-module imports ─────────────────────────────────────────────────

import {
  emitThrowString,
  wasmFuncReturnsVoid,
  wasmFuncTypeReturnsVoid,
  getFuncParamTypes,
  getWasmFuncReturnType,
} from "./expressions/helpers.js";

import {
  shiftLateImportIndices,
  ensureLateImport,
  flushLateImportShifts,
  emitUndefined,
  ensureGetUndefined,
  ensureExternIsUndefinedImport,
  patchStructNewForAddedField,
} from "./expressions/late-imports.js";

import {
  compileIdentifier,
  narrowTypeToUnbox,
  resolveInstanceOfRHS,
  compileHostInstanceOf,
  analyzeTdzAccessByPos,
} from "./expressions/identifiers.js";

import {
  compileLogicalAnd,
  compileLogicalOr,
  compileNullishCoalescing,
  emitMappedArgParamSync,
  emitMappedArgReverseSync,
} from "./expressions/logical-ops.js";

import {
  compileAssignment,
  compileLogicalAssignment,
  compileCompoundAssignment,
  isCompoundAssignment,
  compileDestructuringAssignment,
  compileArrayDestructuringAssignment,
  compilePropertyAssignment,
  compileElementAssignment,
  compileExternSetFallback,
} from "./expressions/assignment.js";

import { compilePrefixUnary, compilePostfixUnary, compileMemberIncDec } from "./expressions/unary.js";

import { compileCallExpression, compileOptionalCallExpression, compileIIFE } from "./expressions/calls.js";

import {
  compileSuperMethodCall,
  compileSuperElementMethodCall,
  compileSuperPropertyAccess,
  compileSuperElementAccess,
  compileNewExpression,
  compileClassExpression,
  resolveEnclosingClassName,
} from "./expressions/new-super.js";

import {
  findExternInfoForMember,
  compileExternMethodCall,
  emitLazyProtoGet,
  patchStructNewForDynamicField,
  patchStructNewInBody,
  defaultValueInstrForType,
  compileSpreadCallArgs,
} from "./expressions/extern.js";

import { compileConsoleCall, compileDateMethodCall, compileMathCall } from "./expressions/builtins.js";

import {
  compileConditionalExpression,
  resolveStructName,
  isGeneratorIteratorResultLike,
  getIteratorResultValueType,
  compileYieldExpression,
  tryStaticToNumber,
} from "./expressions/misc.js";

// Closures (used inside compileExpressionInner)
import { compileArrowFunction } from "./closures.js";

// Property access + binary ops (used inside compileExpressionInner)
import { compileBinaryExpression } from "./binary-ops.js";
import { compileElementAccess, compilePropertyAccess } from "./property-access.js";
import { compileObjectLiteral, compileArrayLiteral } from "./literals.js";
import { compileDeleteExpression, compileRegExpLiteral, compileTypeofExpression } from "./typeof-delete.js";
import { compileTaggedTemplateExpression, compileTemplateExpression } from "./string-ops.js";

// ── Public re-exports (preserves the external API) ────────────────────

export {
  compileArrayMethodCall,
  compileArrayPrototypeCall,
  emitBoundsCheckedArrayGet,
  emitClampIndex,
  emitClampNonNeg,
} from "./array-methods.js";
export { compileNumericBinaryOp } from "./binary-ops.js";
export { collectReferencedIdentifiers, collectWrittenIdentifiers } from "./closures.js";
export { getWellKnownSymbolId, resolveComputedKeyExpression, resolveConstantExpression } from "./literals.js";
export {
  compileObjectDefineProperty,
  compileObjectDefineProperties,
  compileObjectKeysOrValues,
  compilePropertyIntrospection,
} from "./object-ops.js";
export {
  compileElementAccess,
  compileOptionalPropertyAccess,
  compilePropertyAccess,
  emitNullCheckThrow,
  isProvablyNonNull,
} from "./property-access.js";
export { getCol, getLine, valTypesMatch, VOID_RESULT } from "./shared.js";
export {
  compileNativeStringLiteral,
  compileNativeStringMethodCall,
  compileNativeTemplateExpression,
  compileStringBinaryOp,
  compileStringLiteral,
  compileTaggedTemplateExpression,
  compileTemplateExpression,
  emitBoolToString,
} from "./string-ops.js";
export { coercionInstrs, defaultValueInstrs, pushDefaultValue, pushParamSentinel } from "./type-coercion.js";
export { compileInstanceOf, compileTypeofComparison } from "./typeof-delete.js";

// Re-exports from sub-modules
export { emitThrowString, getFuncParamTypes } from "./expressions/helpers.js";
export {
  shiftLateImportIndices,
  ensureLateImport,
  flushLateImportShifts,
  emitUndefined,
  ensureGetUndefined,
  ensureExternIsUndefinedImport,
  patchStructNewForAddedField,
} from "./expressions/late-imports.js";
export { compileIdentifier, narrowTypeToUnbox, analyzeTdzAccessByPos } from "./expressions/identifiers.js";
export { compileLogicalAnd, compileLogicalOr, compileNullishCoalescing } from "./expressions/logical-ops.js";
export {
  compileAssignment,
  compileLogicalAssignment,
  compileCompoundAssignment,
  isCompoundAssignment,
} from "./expressions/assignment.js";
export { compilePrefixUnary, compilePostfixUnary, compileMemberIncDec } from "./expressions/unary.js";
export { compileCallExpression, compileOptionalCallExpression, compileIIFE } from "./expressions/calls.js";
export {
  compileSuperPropertyAccess,
  compileSuperElementAccess,
  compileNewExpression,
  compileClassExpression,
  resolveEnclosingClassName,
} from "./expressions/new-super.js";
export { emitLazyProtoGet, findExternInfoForMember } from "./expressions/extern.js";
export {
  resolveStructName,
  isGeneratorIteratorResultLike,
  getIteratorResultValueType,
  tryStaticToNumber,
} from "./expressions/misc.js";

// ── Dispatcher helpers (used only within this file) ────────────────────

/**
 * Check if a call expression targets an async function/method.
 * Used to determine whether the result needs Promise.resolve() wrapping (#919).
 */
function isAsyncCallExpression(ctx: CodegenContext, expr: ts.CallExpression): boolean {
  if (ts.isIdentifier(expr.expression)) {
    if (ctx.asyncFunctions.has(expr.expression.text)) return true;
  }

  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const decl = sig.getDeclaration();
    if (decl && (decl as any).modifiers) {
      // Exclude async generators — they return AsyncGenerator objects, not Promises.
      if (ts.isFunctionLike(decl) && (decl as ts.FunctionLikeDeclaration).asteriskToken) return false;
      for (const mod of (decl as any).modifiers) {
        if (mod.kind === ts.SyntaxKind.AsyncKeyword) return true;
      }
    }
  }

  return false;
}

/**
 * Wrap the current stack value in Promise.resolve() for async function calls (#919).
 */
function wrapAsyncReturn(ctx: CodegenContext, fctx: FunctionContext, resultType: InnerResult): ValType {
  if (resultType === null || resultType === VOID_RESULT) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (resultType.kind !== "externref") {
    coerceType(ctx, fctx, resultType, { kind: "externref" });
  }
  const resolveIdx = ensureLateImport(ctx, "Promise_resolve", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (resolveIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: resolveIdx });
  }
  return { kind: "externref" };
}

/**
 * Check whether the last instruction emitted since bodyLenBefore is a
 * void-returning call.
 */
function _isLastInstrVoidCall(ctx: CodegenContext, fctx: FunctionContext, bodyLenBefore: number): boolean {
  if (fctx.body.length <= bodyLenBefore) return true;
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (!lastInstr) return false;
  const op = (lastInstr as any).op;
  if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
    return wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
  }
  if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
    return wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
  }
  return false;
}

// ── Recursion depth guard ──────────────────────────────────────────────

let __compileDepth = 0;
const MAX_COMPILE_DEPTH = 500;
export function resetCompileDepth(): void {
  __compileDepth = 0;
}

// ── Main entry points ──────────────────────────────────────────────────

export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  __compileDepth++;
  if (__compileDepth > MAX_COMPILE_DEPTH) {
    __compileDepth--;
    reportError(ctx, expr, `compilation depth exceeded (${MAX_COMPILE_DEPTH}) — possible infinite recursion`);
    const fallbackType = expectedType ?? { kind: "externref" as const };
    if (fallbackType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (fallbackType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else fctx.body.push({ op: "ref.null.extern" } as any);
    return fallbackType;
  }
  try {
    return compileExpressionBody(ctx, fctx, expr, expectedType);
  } finally {
    __compileDepth--;
  }
}

function compileExpressionBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  if (expr) ctx.lastKnownNode = expr;

  if (!expr) {
    reportErrorNoNode(ctx, "unexpected undefined AST node in compileExpression");
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType, ctx);
    return fallbackType;
  }

  // Fast-path: null/undefined in numeric context
  if (expectedType?.kind === "f64" || expectedType?.kind === "i32") {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: isNull ? 0 : NaN });
        return { kind: "f64" };
      }
      if (expectedType.kind === "i32") {
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
      }
    }
    if (expectedType.kind === "i32" && ts.isNumericLiteral(inner)) {
      const litVal = Number(inner.text.replace(/_/g, ""));
      if (Number.isInteger(litVal) && litVal >= -2147483648 && litVal <= 2147483647) {
        fctx.body.push({ op: "i32.const", value: litVal });
        return { kind: "i32" };
      }
    }
    if (ts.isVoidExpression(inner)) {
      const bodyLenBefore = fctx.body.length;
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        if (!_isLastInstrVoidCall(ctx, fctx, bodyLenBefore)) {
          fctx.body.push({ op: "drop" });
        }
      }
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: NaN });
        return { kind: "f64" };
      }
      fctx.body.push({ op: "i32.const", value: 0 });
      return { kind: "i32" };
    }
  }

  // Fast-path: null/undefined in struct ref context
  if (expectedType && (expectedType.kind === "ref_null" || expectedType.kind === "ref")) {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      const typeIdx = (expectedType as { typeIdx: number }).typeIdx;
      fctx.body.push({ op: "ref.null", typeIdx });
      return { kind: "ref_null", typeIdx };
    }
  }

  // Fast-path: null/undefined/boolean literals in AnyValue context
  if (expectedType && isAnyValue(expectedType, ctx)) {
    let inner: ts.Expression = expr;
    while (
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isParenthesizedExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = ts.isParenthesizedExpression(inner)
        ? inner.expression
        : ts.isAsExpression(inner)
          ? inner.expression
          : ts.isNonNullExpression(inner)
            ? inner.expression
            : (inner as ts.TypeAssertion).expression;
    }
    const isNull = inner.kind === ts.SyntaxKind.NullKeyword;
    const isUndefined =
      inner.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(inner) && inner.text === "undefined") ||
      ts.isOmittedExpression(inner);
    if (isNull || isUndefined) {
      ensureAnyHelpers(ctx);
      const helperName = isNull ? "__any_box_null" : "__any_box_undefined";
      const funcIdx = ctx.funcMap.get(helperName);
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
    if (ts.isVoidExpression(inner)) {
      const bodyLenBefore2 = fctx.body.length;
      const operandType = compileExpressionInner(ctx, fctx, inner.expression);
      if (operandType !== null && operandType !== VOID_RESULT) {
        if (!_isLastInstrVoidCall(ctx, fctx, bodyLenBefore2)) {
          fctx.body.push({ op: "drop" });
        }
      }
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_undefined");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
    if (inner.kind === ts.SyntaxKind.TrueKeyword || inner.kind === ts.SyntaxKind.FalseKeyword) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_box_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({
          op: "i32.const",
          value: inner.kind === ts.SyntaxKind.TrueKeyword ? 1 : 0,
        });
        fctx.body.push({ op: "call", funcIdx });
        return expectedType;
      }
    }
  }

  const bodyLenBefore = fctx.body.length;
  let result: InnerResult;
  try {
    result = compileExpressionInner(ctx, fctx, expr);
  } catch (e) {
    fctx.body.length = bodyLenBefore;
    const msg = e instanceof Error ? e.message : String(e);
    reportErrorNoNode(ctx, `Internal error compiling expression: ${msg}`);
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType, ctx);
    return fallbackType;
  }
  if (result === VOID_RESULT) {
    if (expectedType) {
      if (expectedType.kind === "f64") {
        fctx.body.push({ op: "f64.const", value: NaN });
      } else {
        pushDefaultValue(fctx, expectedType, ctx);
      }
      return expectedType;
    }
    return null;
  }
  if (result !== null && fctx.body.length > bodyLenBefore) {
    const lastInstr = fctx.body[fctx.body.length - 1];
    if (lastInstr) {
      const op = (lastInstr as any).op;
      let isVoidCall = false;
      if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
        isVoidCall = wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
      } else if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
        isVoidCall = wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
      }
      if (isVoidCall) {
        if (expectedType) {
          pushDefaultValue(fctx, expectedType, ctx);
          return expectedType;
        }
        return null;
      }
    }
  }
  if (result !== null && (typeof result !== "object" || result === null || !("kind" in result))) {
    const fallbackType = expectedType ?? { kind: "f64" as const };
    pushDefaultValue(fctx, fallbackType, ctx);
    return fallbackType;
  }
  if (result !== null) {
    if (expectedType && result.kind !== expectedType.kind) {
      if (result.kind === "i32" && isAnyValue(expectedType, ctx)) {
        const tsType = ctx.checker.getTypeAtLocation(expr);
        if (tsType.flags & ts.TypeFlags.BooleanLike) {
          ensureAnyHelpers(ctx);
          const funcIdx = ctx.funcMap.get("__any_box_bool");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return expectedType;
          }
        }
      }
      if (result.kind === "i32" && expectedType.kind === "externref") {
        const tsType = ctx.checker.getTypeAtLocation(expr);
        if (tsType.flags & ts.TypeFlags.ESSymbolLike) {
          const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
          if (boxSymIdx !== undefined) {
            flushLateImportShifts(ctx, fctx);
            fctx.body.push({ op: "call", funcIdx: boxSymIdx } as unknown as Instr);
            return expectedType;
          }
        }
      }
      coerceType(ctx, fctx, result, expectedType);
      return expectedType;
    }
    if (
      expectedType &&
      (result.kind === "ref" || result.kind === "ref_null") &&
      (expectedType.kind === "ref" || expectedType.kind === "ref_null")
    ) {
      const resultIdx = (result as { typeIdx: number }).typeIdx;
      const expectedIdx = (expectedType as { typeIdx: number }).typeIdx;
      if (resultIdx !== expectedIdx) {
        coerceType(ctx, fctx, result, expectedType);
        return expectedType;
      }
    }
    return result;
  }

  fctx.body.length = bodyLenBefore;
  let wasmType: ValType;
  if (expectedType) {
    wasmType = expectedType;
  } else {
    try {
      wasmType = mapTsTypeToWasm(ctx.checker.getTypeAtLocation(expr), ctx.checker);
    } catch {
      wasmType = { kind: "f64" };
    }
  }
  pushDefaultValue(fctx, wasmType, ctx);
  return wasmType;
}

/**
 * Emit a local.set with automatic type coercion.
 */
export function emitCoercedLocalSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  localIdx: number,
  stackType: ValType,
): void {
  const localType = getLocalType(fctx, localIdx);
  if (localType && !valTypesMatch(stackType, localType)) {
    const sameRefTypeIdx =
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null") &&
      (stackType as { typeIdx: number }).typeIdx === (localType as { typeIdx: number }).typeIdx;
    if (sameRefTypeIdx && stackType.kind === "ref_null" && localType.kind === "ref") {
      widenLocalToNullable(fctx, localIdx);
    } else if (sameRefTypeIdx) {
      // ref -> ref_null: subtype, no coercion needed
    } else if (
      (stackType.kind === "ref" || stackType.kind === "ref_null") &&
      (localType.kind === "ref" || localType.kind === "ref_null")
    ) {
      const bodyLenBefore = fctx.body.length;
      coerceType(ctx, fctx, stackType, localType);
      if (fctx.body.length === bodyLenBefore) {
        updateLocalType(fctx, localIdx, stackType);
      }
    } else {
      coerceType(ctx, fctx, stackType, localType);
    }
  }
  fctx.body.push({ op: "local.set", index: localIdx });
}

function updateLocalType(fctx: FunctionContext, localIdx: number, newType: ValType): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param) param.type = newType;
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local) local.type = newType;
  }
}

function widenLocalToNullable(fctx: FunctionContext, localIdx: number): void {
  if (localIdx < fctx.params.length) {
    const param = fctx.params[localIdx];
    if (param && param.type.kind === "ref") {
      param.type = {
        kind: "ref_null",
        typeIdx: (param.type as { typeIdx: number }).typeIdx,
      };
    }
  } else {
    const local = fctx.locals[localIdx - fctx.params.length];
    if (local && local.type.kind === "ref") {
      local.type = {
        kind: "ref_null",
        typeIdx: (local.type as { typeIdx: number }).typeIdx,
      };
    }
  }
}

/** Coerce a value on the stack from one type to another */
export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
): void {
  // biome-ignore lint/correctness/noVoidTypeReturn: delegates to void impl
  return coerceTypeImpl(ctx, fctx, from, to, toPrimitiveHint);
}

function compileExpressionInner(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): InnerResult {
  if (ts.isNumericLiteral(expr)) {
    const value = Number(expr.text.replace(/_/g, ""));
    if (ctx.fast && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
      fctx.body.push({ op: "i32.const", value });
      return { kind: "i32" };
    }
    fctx.body.push({ op: "f64.const", value });
    return { kind: "f64" };
  }

  if (ts.isBigIntLiteral(expr)) {
    const text = expr.text.replace(/_/g, "").replace(/n$/i, "");
    const value = BigInt(text);
    fctx.body.push({ op: "i64.const", value });
    return { kind: "i64" };
  }

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return compileStringLiteral(ctx, fctx, expr.text, expr);
  }

  if (ts.isTemplateExpression(expr)) {
    return compileTemplateExpression(ctx, fctx, expr);
  }

  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr) && expr.text === "undefined") {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isOmittedExpression(expr)) {
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const selfIdx = fctx.localMap.get("this");
    if (selfIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: selfIdx });
      if (selfIdx < fctx.params.length) {
        return fctx.params[selfIdx]!.type;
      }
      const localDef = fctx.locals[selfIdx - fctx.params.length];
      return localDef?.type ?? { kind: "externref" };
    }
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isIdentifier(expr)) {
    return compileIdentifier(ctx, fctx, expr);
  }

  if (ts.isBinaryExpression(expr)) {
    if (expr.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
      const rhsResult = resolveInstanceOfRHS(ctx, expr.right);
      if (!rhsResult) {
        return compileHostInstanceOf(ctx, fctx, expr);
      }
    }
    return compileBinaryExpression(ctx, fctx, expr);
  }

  if (ts.isTypeOfExpression(expr)) {
    return compileTypeofExpression(ctx, fctx, expr);
  }

  if (ts.isPrefixUnaryExpression(expr)) {
    return compilePrefixUnary(ctx, fctx, expr);
  }

  if (ts.isPostfixUnaryExpression(expr)) {
    return compilePostfixUnary(ctx, fctx, expr);
  }

  if (ts.isParenthesizedExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  if (ts.isCallExpression(expr)) {
    const callResult = compileCallExpression(ctx, fctx, expr);
    if (fctx.pendingCallbackWritebacks && fctx.pendingCallbackWritebacks.length > 0) {
      fctx.body.push(...fctx.pendingCallbackWritebacks);
      fctx.pendingCallbackWritebacks = undefined;
    }
    if (isAsyncCallExpression(ctx, expr)) {
      return wrapAsyncReturn(ctx, fctx, callResult);
    }
    return callResult;
  }

  if (ts.isNewExpression(expr)) {
    return compileNewExpression(ctx, fctx, expr);
  }

  if (ts.isConditionalExpression(expr)) {
    return compileConditionalExpression(ctx, fctx, expr);
  }

  if (ts.isPropertyAccessExpression(expr)) {
    return compilePropertyAccess(ctx, fctx, expr);
  }

  if (ts.isElementAccessExpression(expr)) {
    return compileElementAccess(ctx, fctx, expr);
  }

  if (ts.isObjectLiteralExpression(expr)) {
    return compileObjectLiteral(ctx, fctx, expr);
  }

  if (ts.isArrayLiteralExpression(expr)) {
    return compileArrayLiteral(ctx, fctx, expr);
  }

  if (ts.isAsExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  if (ts.isNonNullExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  if (ts.isAwaitExpression(expr)) {
    return compileExpressionInner(ctx, fctx, expr.expression);
  }

  if (ts.isYieldExpression(expr)) {
    return compileYieldExpression(ctx, fctx, expr);
  }

  if (ts.isVoidExpression(expr)) {
    const voidBodyLen = fctx.body.length;
    const operandType = compileExpressionInner(ctx, fctx, expr.expression);
    if (operandType !== null && operandType !== VOID_RESULT) {
      if (!_isLastInstrVoidCall(ctx, fctx, voidBodyLen)) {
        fctx.body.push({ op: "drop" });
      }
    }
    emitUndefined(ctx, fctx);
    return { kind: "externref" };
  }

  if (ts.isDeleteExpression(expr)) {
    return compileDeleteExpression(ctx, fctx, expr);
  }

  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return compileArrowFunction(ctx, fctx, expr);
  }

  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.NewKeyword && expr.name.text === "target") {
    if (fctx.isConstructor) {
      fctx.body.push({ op: "i32.const", value: 1 });
      return { kind: "i32" };
    } else {
      emitUndefined(ctx, fctx);
      return { kind: "externref" };
    }
  }

  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.ImportKeyword && expr.name.text === "meta") {
    return compileStringLiteral(ctx, fctx, "[object Object]");
  }

  if (ts.isMetaProperty(expr) && expr.keywordToken === ts.SyntaxKind.ImportKeyword) {
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return compileRegExpLiteral(ctx, fctx, expr);
  }

  if (ts.isTaggedTemplateExpression(expr)) {
    return compileTaggedTemplateExpression(ctx, fctx, expr);
  }

  if (ts.isClassExpression(expr)) {
    return compileClassExpression(ctx, fctx, expr);
  }

  if (ts.isPrivateIdentifier(expr)) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return { kind: "i32" };
  }

  if (expr.kind === ts.SyntaxKind.SuperKeyword) {
    const selfIdx = fctx.localMap.get("this");
    if (selfIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: selfIdx });
      const selfType = fctx.locals[selfIdx];
      if (selfType) return selfType.type;
    }
    fctx.body.push({ op: "ref.null.extern" });
    return { kind: "externref" };
  }

  if (ts.isSpreadElement(expr as any)) {
    return compileExpressionInner(ctx, fctx, (expr as any as ts.SpreadElement).expression);
  }

  reportError(ctx, expr, `Unsupported expression: ${ts.SyntaxKind[expr.kind]}`);
  return null;
}

// Register delegates in shared.ts so other modules (array-methods, etc.) can
// call compileExpression / ensureLateImport / flushLateImportShifts without
// creating circular imports.
registerCompileExpression(compileExpression);
registerEnsureLateImport(ensureLateImport);
registerFlushLateImportShifts(flushLateImportShifts);
