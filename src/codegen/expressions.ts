// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
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
import { ts } from "../ts-api.js";
import { mapTsTypeToWasm } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  emitStandalonePromiseReject,
  emitStandalonePromiseResolve,
  getOrRegisterPromiseType,
  isStandalonePromiseActive,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
} from "./async-scheduler.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import {
  ensureAnyHelpers,
  isAnyValue,
  registerCompileExpression,
  registerEnsureLateImport,
  registerFlushLateImportShifts,
  valTypesMatch,
  VOID_RESULT,
} from "./shared.js";
import { compileStringLiteral } from "./string-ops.js";
import { coerceType as coerceTypeImpl, pushDefaultValue } from "./type-coercion.js";

// ── Sub-module imports ─────────────────────────────────────────────────

import { wasmFuncReturnsVoid, wasmFuncTypeReturnsVoid } from "./expressions/helpers.js";

import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

import { compileHostInstanceOf, compileIdentifier, resolveInstanceOfRHS } from "./expressions/identifiers.js";

import { compilePostfixUnary, compilePrefixUnary } from "./expressions/unary.js";

import { compileCallExpression } from "./expressions/calls.js";

import { compileClassExpression, compileNewExpression } from "./expressions/new-super.js";

import { compileConditionalExpression, compileYieldExpression } from "./expressions/misc.js";

// Closures (used inside compileExpressionInner)
import { compileArrowFunction } from "./closures.js";

// Property access + binary ops (used inside compileExpressionInner)
import { compileBinaryExpression } from "./binary-ops.js";
import { compileArrayLiteral, compileObjectLiteral } from "./literals.js";
import { compileElementAccess, compilePropertyAccess } from "./property-access.js";
import { compileTaggedTemplateExpression, compileTemplateExpression } from "./string-ops.js";
import { compileDeleteExpression, compileRegExpLiteral, compileTypeofExpression } from "./typeof-delete.js";

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
  compileObjectDefineProperties,
  compileObjectDefineProperty,
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
export {
  compileAssignment,
  compileCompoundAssignment,
  compileLogicalAssignment,
  isCompoundAssignment,
} from "./expressions/assignment.js";
export { compileCallExpression, compileIIFE, compileOptionalCallExpression } from "./expressions/calls.js";
export { emitLazyProtoGet, findExternInfoForMember } from "./expressions/extern.js";
export { emitThrowString, getFuncParamTypes } from "./expressions/helpers.js";
export {
  analyzeTdzAccessByPos,
  compileIdentifier,
  computeElidableTopLevelTdzNames,
  narrowTypeToUnbox,
} from "./expressions/identifiers.js";
export {
  emitUndefined,
  ensureExternIsUndefinedImport,
  ensureGetUndefined,
  ensureLateImport,
  flushLateImportShifts,
  patchStructNewForAddedField,
  shiftLateImportIndices,
} from "./expressions/late-imports.js";
export { compileLogicalAnd, compileLogicalOr, compileNullishCoalescing } from "./expressions/logical-ops.js";
export {
  getIteratorResultValueType,
  isGeneratorIteratorResultLike,
  resolveStructName,
  tryStaticToNumber,
} from "./expressions/misc.js";
export {
  compileClassExpression,
  compileNewExpression,
  compileSuperElementAccess,
  compileSuperPropertyAccess,
  resolveEnclosingClassName,
} from "./expressions/new-super.js";
export { compileMemberIncDec, compilePostfixUnary, compilePrefixUnary } from "./expressions/unary.js";

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
 *
 * `resultType` is the TypeScript-level result from compileCallExpression; when
 * the TS signature says `Promise<void>` that helper returns `VOID_RESULT` even
 * though the underlying wasm function still leaves an externref on the stack.
 * Check the last emitted call against the wasm type table — if a value is
 * already on the stack, skip the `ref.null.extern` push (otherwise the later
 * stack-balance pass would drop the Promise we just built).
 */
function wrapAsyncReturn(ctx: CodegenContext, fctx: FunctionContext, resultType: InnerResult): ValType {
  const lastInstr = fctx.body[fctx.body.length - 1];
  let wasmStackHasValue = false;
  if (lastInstr) {
    const op = (lastInstr as any).op;
    if (op === "call" && (lastInstr as any).funcIdx !== undefined) {
      wasmStackHasValue = !wasmFuncReturnsVoid(ctx, (lastInstr as any).funcIdx);
    } else if (op === "call_ref" && (lastInstr as any).typeIdx !== undefined) {
      wasmStackHasValue = !wasmFuncTypeReturnsVoid(ctx, (lastInstr as any).typeIdx);
    }
  }
  if (resultType === null || resultType === VOID_RESULT) {
    if (!wasmStackHasValue) fctx.body.push({ op: "ref.null.extern" });
  } else if (resultType.kind !== "externref") {
    coerceType(ctx, fctx, resultType, { kind: "externref" });
  }
  // (#1326 Phase 1B) In standalone (WASI) mode, replace
  // `call $Promise_resolve_import` with a Wasm-native `$Promise`
  // struct.new fulfilled with the value already on the stack. The host
  // import `Promise_resolve` is unsatisfiable in WASI; this branch
  // avoids the missing-import error at module instantiation.
  //
  // Wasm `struct.new` pops fields in declaration order (state | value |
  // callbacks); the value is already on the stack but state must come
  // BEFORE it. Stash via a temp local, then emit in the correct order.
  if (isStandalonePromiseActive(ctx)) {
    const valueLocal = allocTempLocal(fctx, { kind: "externref" });
    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    fctx.body.push({ op: "local.set", index: valueLocal });
    fctx.body.push({ op: "i32.const", value: PROMISE_STATE_FULFILLED });
    fctx.body.push({ op: "local.get", index: valueLocal });
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
    releaseTempLocal(fctx, valueLocal);
    return { kind: "externref" };
  }
  const resolveIdx = ensureLateImport(ctx, "Promise_resolve", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (resolveIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: resolveIdx });
  }
  return { kind: "externref" };
}

/**
 * Splice instructions [start..end) from fctx.body and re-emit them inside a
 * try/catch that converts synchronous throws into a rejected Promise. Used for
 * async function calls so that a throw during default-param evaluation or body
 * execution surfaces as `f().then(_, onRej)` rather than an uncaught wasm
 * exception (#1150).
 */
function wrapAsyncCallInTryCatch(ctx: CodegenContext, fctx: FunctionContext, start: number): void {
  // (#1326 Phase 1B) Standalone-mode rejection. The host
  // `Promise_reject` import + `__get_caught_exception` are
  // unsatisfiable in WASI; emit a Wasm-native rejected `$Promise`
  // construction in the catch_all instead.
  if (isStandalonePromiseActive(ctx)) {
    const promiseTypeIdx = getOrRegisterPromiseType(ctx);
    const inner = fctx.body.splice(start);
    // The thrown value is on the catch_all stack as externref (the
    // `__exn` tag's externref payload); standalone catch_all consumes
    // it and uses it as the rejection reason. We don't have access to
    // the wasm exception payload op without `ensureExnTag`, so fall
    // back to `ref.null.extern` as the reason — Phase 1B doesn't
    // yet wire the catch-payload binding (Phase 1C will). Most async
    // throws produce undefined-typed rejections at this stage, so
    // null-extern is safe.
    const catchAll: Instr[] = [
      { op: "i32.const", value: PROMISE_STATE_REJECTED },
      { op: "ref.null.extern" } as Instr,
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: promiseTypeIdx } as Instr,
      { op: "extern.convert_any" } as Instr,
    ];
    fctx.body.push({
      op: "try",
      blockType: { kind: "val", type: { kind: "externref" } },
      body: inner,
      catches: [],
      catchAll,
    } as unknown as Instr);
    return;
  }
  const rejectIdx = ensureLateImport(ctx, "Promise_reject", [{ kind: "externref" }], [{ kind: "externref" }]);
  const getCaughtIdx = ensureLateImport(ctx, "__get_caught_exception", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (rejectIdx === undefined || getCaughtIdx === undefined) return;
  const inner = fctx.body.splice(start);
  const catchAll: Instr[] = [
    { op: "call", funcIdx: getCaughtIdx } as Instr,
    { op: "call", funcIdx: rejectIdx } as Instr,
  ];
  fctx.body.push({
    op: "try",
    blockType: { kind: "val", type: { kind: "externref" } },
    body: inner,
    catches: [],
    catchAll,
  } as unknown as Instr);
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
      // (#1366a) Externref-backed subclasses (extends Error / TypeError / ...)
      // have instances that are real JS Error objects whose host-side
      // [[Prototype]] is the BUILTIN parent (Error.prototype), not
      // MyError.prototype. So `e instanceof MyError` cannot be answered by a
      // host `__instanceof(value, "MyError")` call (globalThis.MyError does
      // not exist). We resolve it statically using the TS type of LHS:
      //
      //   - LHS type ≡ MyError or a registered subclass → constant `true`
      //   - LHS type ≡ unrelated user class → constant `false`
      //   - otherwise (any / externref / parent builtin) → fall back to host
      //     `__instanceof` against the BUILTIN parent name. (`e instanceof
      //     MyError` where e is `any` is unanswerable here; we
      //     conservatively return false to match host semantics.)
      //
      // The WasmGC struct-tag path is wrong for these instances anyway
      // (any.convert_extern + ref.cast to a struct type fails), so we never
      // dispatch to compileInstanceOf for an externref-backed RHS.
      if (ctx.classExternrefBackedSet.has(rhsResult)) {
        const lhsTsType = ctx.checker.getTypeAtLocation(expr.left);
        const lhsName = lhsTsType.getSymbol()?.name;
        let staticAnswer: boolean | undefined;
        if (lhsName !== undefined) {
          if (lhsName === rhsResult) {
            staticAnswer = true;
          } else if (ctx.classTagMap.has(lhsName)) {
            // LHS is a known user class. Walk its parent chain — true iff the
            // RHS class is an ancestor of the LHS class.
            let cur: string | undefined = lhsName;
            const guard = new Set<string>();
            while (cur && !guard.has(cur)) {
              guard.add(cur);
              if (cur === rhsResult) {
                staticAnswer = true;
                break;
              }
              cur = ctx.classParentMap.get(cur);
            }
            if (staticAnswer === undefined) staticAnswer = false;
          }
        }
        if (staticAnswer !== undefined) {
          // Compile LHS for side effects, drop, push constant.
          const leftType = compileExpression(ctx, fctx, expr.left);
          if (leftType) fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "i32.const", value: staticAnswer ? 1 : 0 });
          return { kind: "i32" };
        }
        // Could not decide statically — return false (host-side
        // __instanceof against MyError name would return 0 anyway).
        const leftType = compileExpression(ctx, fctx, expr.left);
        if (leftType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "i32.const", value: 0 });
        return { kind: "i32" };
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
    const callStart = fctx.body.length;
    const callResult = compileCallExpression(ctx, fctx, expr);
    if (fctx.pendingCallbackWritebacks && fctx.pendingCallbackWritebacks.length > 0) {
      fctx.body.push(...fctx.pendingCallbackWritebacks);
      fctx.pendingCallbackWritebacks = undefined;
    }
    // Emit persistent writebacks (#929): for getter/setter callbacks whose mutable
    // captures may be updated by a deferred callback invocation (e.g. a getter
    // defined via Object.defineProperty and later called by Object.defineProperties).
    // These are re-emitted after every call so the outer locals stay up-to-date.
    if (fctx.persistentCallbackWritebacks && fctx.persistentCallbackWritebacks.length > 0) {
      // Shallow-copy each instruction so dead-elimination doesn't multi-remap
      // the same object when it appears multiple times in the function body.
      fctx.body.push(...fctx.persistentCallbackWritebacks.map((instr) => ({ ...instr })));
      // Do NOT clear — re-emit after every subsequent call
    }
    // Skip async-call detection for `import.defer(...)` / `import.source(...)`:
    // calling `getResolvedSignature` on these triggers a TypeScript Debug.assert
    // ("Trying to get the type of `import.defer` in `import.defer(...)`") because
    // the TS checker explicitly forbids type queries on these meta-properties as
    // call callees. The compileCallExpression dispatcher (calls.ts) already
    // reports a clean unsupported-feature error for these patterns; here we just
    // bypass the async wrap. (#1315)
    if (
      ts.isMetaProperty(expr.expression) &&
      expr.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      (expr.expression.name.text === "defer" || expr.expression.name.text === "source")
    ) {
      return callResult;
    }
    if (isAsyncCallExpression(ctx, expr)) {
      // (#1313) `await asyncCall()` would otherwise leave a Promise object
      // on the stack — string concatenation / arithmetic / property access
      // on the result then sees `[object Promise]` because js2wasm has no
      // synchronous Promise unwrap (would need JSPI / stack-switching).
      //
      // Workaround: skip the `Promise.resolve(...)` wrap when the call's
      // parent is an `AwaitExpression`. The wasm async function body
      // (`closures.ts:1165`) already returns the raw `T` value (not
      // `Promise<T>`), so leaving it on the stack matches what await's
      // passthrough lowering expects. For non-await consumers
      // (`asyncCall().then(...)`, `const p = asyncCall();`) the wrap still
      // fires and produces a real Promise that JS host code can chain off.
      //
      // This is the asymmetric strategy 1 from the issue: await as
      // raw-T consumer, every other consumer as Promise consumer. Both
      // shapes are observable in test262 today; this PR keeps both
      // working while eliminating the `[object Promise]` stringification.
      let parent: ts.Node | undefined = expr.parent;
      while (
        parent &&
        (ts.isParenthesizedExpression(parent) ||
          ts.isAsExpression(parent) ||
          ts.isNonNullExpression(parent) ||
          ts.isTypeAssertionExpression(parent))
      ) {
        parent = parent.parent;
      }
      if (parent && ts.isAwaitExpression(parent)) {
        // Skip the wrap; await's passthrough lowering will leave the raw
        // value on the stack for the consumer.
        return callResult;
      }
      const wrappedType = wrapAsyncReturn(ctx, fctx, callResult);
      // Wrap the call+Promise.resolve in try/catch so synchronous throws from
      // the async function body (e.g. TDZ ReferenceError during default param
      // evaluation) become rejected Promises per spec (#1150).
      wrapAsyncCallInTryCatch(ctx, fctx, callStart);
      return wrappedType;
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
