/**
 * Shared types, values, and late-bound function registrations for the codegen
 * modules.  This module exists solely to break circular dependencies between
 * expressions.ts and the feature-specific modules (closures.ts, etc.).
 *
 * Convention: the *real* implementation lives in the feature module and calls
 * `registerXxx(impl)` at module scope.  Consumers import the delegate wrapper
 * from this file.
 */

import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";

// ── VOID_RESULT sentinel ──────────────────────────────────────────────

/** Sentinel: expression compiled successfully but produces no value (void) */
export const VOID_RESULT = Symbol("void");
export type InnerResult = ValType | null | typeof VOID_RESULT;

// ── resolveThisStructName ─────────────────────────────────────────────

/**
 * When `this` is typed as `any` (e.g., in function constructors), resolve the
 * struct name from the local's ref type index. Used as a fallback when
 * resolveStructName returns undefined for `this`-property accesses/assignments.
 */
export function resolveThisStructName(ctx: CodegenContext, fctx: FunctionContext): string | undefined {
  const selfIdx = fctx.localMap.get("this");
  if (selfIdx === undefined) return undefined;
  const selfType =
    selfIdx < fctx.params.length ? fctx.params[selfIdx]!.type : fctx.locals[selfIdx - fctx.params.length]?.type;
  if (!selfType || (selfType.kind !== "ref" && selfType.kind !== "ref_null")) return undefined;
  const typeIdx = (selfType as { typeIdx: number }).typeIdx;
  return ctx.typeIdxToStructName.get(typeIdx);
}

// ── valTypesMatch ─────────────────────────────────────────────────────

/** Check if two ValTypes are structurally equal */
export function valTypesMatch(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") && (b.kind === "ref" || b.kind === "ref_null")) {
    return (a as { typeIdx: number }).typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

// ── getLine / getCol ──────────────────────────────────────────────────

export function getLine(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return line + 1;
  } catch {
    return 0;
  }
}

export function getCol(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { character } = sf.getLineAndCharacterOfPosition(node.getStart());
    return character + 1;
  } catch {
    return 0;
  }
}

// ── Late-bound delegates ──────────────────────────────────────────────
// Each delegate starts as a throwing stub and is replaced by the real
// implementation when the owning module is loaded.

type CompileExpressionFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
) => ValType | null;

let _compileExpression: CompileExpressionFn = () => {
  throw new Error("compileExpression not yet registered");
};

export function registerCompileExpression(fn: CompileExpressionFn): void {
  _compileExpression = fn;
}

export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  return _compileExpression(ctx, fctx, expr, expectedType);
}

// ── compileArrowAsClosure ─────────────────────────────────────────────

type CompileArrowAsClosureFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
) => ValType | null;

let _compileArrowAsClosure: CompileArrowAsClosureFn = () => {
  throw new Error("compileArrowAsClosure not yet registered");
};

export function registerCompileArrowAsClosure(fn: CompileArrowAsClosureFn): void {
  _compileArrowAsClosure = fn;
}

export function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  return _compileArrowAsClosure(ctx, fctx, arrow);
}

// ── emitBoundsCheckedArrayGet ─────────────────────────────────────────

type EmitBoundsCheckedArrayGetFn = (fctx: FunctionContext, arrTypeIdx: number, elementType: ValType) => void;

let _emitBoundsCheckedArrayGet: EmitBoundsCheckedArrayGetFn = () => {
  throw new Error("emitBoundsCheckedArrayGet not yet registered");
};

export function registerEmitBoundsCheckedArrayGet(fn: EmitBoundsCheckedArrayGetFn): void {
  _emitBoundsCheckedArrayGet = fn;
}

export function emitBoundsCheckedArrayGet(fctx: FunctionContext, arrTypeIdx: number, elementType: ValType): void {
  _emitBoundsCheckedArrayGet(fctx, arrTypeIdx, elementType);
}

// ── resolveEnclosingClassName ─────────────────────────────────────────

type ResolveEnclosingClassNameFn = (fctx: FunctionContext) => string | undefined;

let _resolveEnclosingClassName: ResolveEnclosingClassNameFn = () => undefined;

export function registerResolveEnclosingClassName(fn: ResolveEnclosingClassNameFn): void {
  _resolveEnclosingClassName = fn;
}

export function resolveEnclosingClassName(fctx: FunctionContext): string | undefined {
  return _resolveEnclosingClassName(fctx);
}

// ── coerceType ────────────────────────────────────────────────────────

type CoerceTypeFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
) => void;

let _coerceType: CoerceTypeFn = () => {
  throw new Error("coerceType not yet registered");
};

export function registerCoerceType(fn: CoerceTypeFn): void {
  _coerceType = fn;
}

export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
): void {
  _coerceType(ctx, fctx, from, to, toPrimitiveHint);
}

// ── ensureLateImport / flushLateImportShifts delegates ───────────────

type EnsureLateImportFn = (
  ctx: CodegenContext,
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
) => number | undefined;

type FlushLateImportShiftsFn = (ctx: CodegenContext, fctx: FunctionContext) => void;

let _ensureLateImport: EnsureLateImportFn = () => {
  throw new Error("ensureLateImport not yet registered");
};

let _flushLateImportShifts: FlushLateImportShiftsFn = () => {
  throw new Error("flushLateImportShifts not yet registered");
};

export function registerEnsureLateImport(fn: EnsureLateImportFn): void {
  _ensureLateImport = fn;
}

export function registerFlushLateImportShifts(fn: FlushLateImportShiftsFn): void {
  _flushLateImportShifts = fn;
}

export function ensureLateImport(
  ctx: CodegenContext,
  name: string,
  paramTypes: ValType[],
  resultTypes: ValType[],
): number | undefined {
  return _ensureLateImport(ctx, name, paramTypes, resultTypes);
}

export function flushLateImportShifts(ctx: CodegenContext, fctx: FunctionContext): void {
  _flushLateImportShifts(ctx, fctx);
}
