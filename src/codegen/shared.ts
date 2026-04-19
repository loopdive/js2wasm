// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared types, values, and late-bound function registrations for the codegen
 * modules.  This module exists solely to break circular dependencies between
 * the main codegen modules (index.ts, expressions.ts, statements.ts) and the
 * feature-specific modules (closures.ts, etc.).
 *
 * Dependency direction:
 *   shared.ts (no deps on main modules)
 *     ↑
 *   registry/*.ts, context/*.ts (low-level)
 *     ↑
 *   index.ts (compiler driver — imports from shared, registry, context)
 *     ↑           ↑
 *   expressions.ts  statements.ts (import from shared and index)
 *
 * Convention: the *real* implementation lives in the feature module and calls
 * `registerXxx(impl)` at module scope.  Consumers import the delegate wrapper
 * from this file.
 */

import ts from "typescript";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";

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

// ── isAnyValue ────────────────────────────────────────────────────────
// Moved here from index.ts so expressions.ts and typeof-delete.ts can import
// it without depending on index.ts (which depends on expressions.ts).

/**
 * Check if a ValType is the any-value boxed type used for TS `any`.
 */
export function isAnyValue(type: ValType, ctx: CodegenContext): boolean {
  return (
    (type.kind === "ref" || type.kind === "ref_null") &&
    (type as { typeIdx: number }).typeIdx === ctx.anyValueTypeIdx &&
    ctx.anyValueTypeIdx >= 0
  );
}

// ── ensureAnyHelpers ──────────────────────────────────────────────────

type EnsureAnyHelpersFn = (ctx: CodegenContext) => void;

let _ensureAnyHelpers: EnsureAnyHelpersFn = () => {
  throw new Error("ensureAnyHelpers not yet registered");
};

export function registerEnsureAnyHelpers(fn: EnsureAnyHelpersFn): void {
  _ensureAnyHelpers = fn;
}

export function ensureAnyHelpers(ctx: CodegenContext): void {
  _ensureAnyHelpers(ctx);
}

// ── resolveComputedKeyExpression ──────────────────────────────────────

type ResolveComputedKeyExpressionFn = (ctx: CodegenContext, expr: ts.Expression) => string | undefined;

let _resolveComputedKeyExpression: ResolveComputedKeyExpressionFn = () => {
  throw new Error("resolveComputedKeyExpression not yet registered");
};

export function registerResolveComputedKeyExpression(fn: ResolveComputedKeyExpressionFn): void {
  _resolveComputedKeyExpression = fn;
}

export function resolveComputedKeyExpression(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  return _resolveComputedKeyExpression(ctx, expr);
}

// ── compileStatement ──────────────────────────────────────────────────

type CompileStatementFn = (ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement) => void;

let _compileStatement: CompileStatementFn = () => {
  throw new Error("compileStatement not yet registered");
};

export function registerCompileStatement(fn: CompileStatementFn): void {
  _compileStatement = fn;
}

export function compileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  _compileStatement(ctx, fctx, stmt);
}

// ── ensureBindingLocals ───────────────────────────────────────────────

type EnsureBindingLocalsFn = (ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern) => void;

let _ensureBindingLocals: EnsureBindingLocalsFn = () => {
  throw new Error("ensureBindingLocals not yet registered");
};

export function registerEnsureBindingLocals(fn: EnsureBindingLocalsFn): void {
  _ensureBindingLocals = fn;
}

export function ensureBindingLocals(ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern): void {
  _ensureBindingLocals(ctx, fctx, pattern);
}

// ── hoistFunctionDeclarations ─────────────────────────────────────────

type HoistFunctionDeclarationsFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
) => void;

let _hoistFunctionDeclarations: HoistFunctionDeclarationsFn = () => {
  throw new Error("hoistFunctionDeclarations not yet registered");
};

export function registerHoistFunctionDeclarations(fn: HoistFunctionDeclarationsFn): void {
  _hoistFunctionDeclarations = fn;
}

export function hoistFunctionDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  _hoistFunctionDeclarations(ctx, fctx, stmts);
}

// ── emitNestedBindingDefault ──────────────────────────────────────────

type EmitNestedBindingDefaultFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  nestedLocal: number,
  valueType: ValType,
  initializer: ts.Expression,
) => void;

let _emitNestedBindingDefault: EmitNestedBindingDefaultFn = () => {
  throw new Error("emitNestedBindingDefault not yet registered");
};

export function registerEmitNestedBindingDefault(fn: EmitNestedBindingDefaultFn): void {
  _emitNestedBindingDefault = fn;
}

export function emitNestedBindingDefault(
  ctx: CodegenContext,
  fctx: FunctionContext,
  nestedLocal: number,
  valueType: ValType,
  initializer: ts.Expression,
): void {
  _emitNestedBindingDefault(ctx, fctx, nestedLocal, valueType, initializer);
}

// ── emitDefaultValueCheck ─────────────────────────────────────────────

type EmitDefaultValueCheckFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  localIdx: number,
  initializer: ts.Expression,
  targetType?: ValType,
) => void;

let _emitDefaultValueCheck: EmitDefaultValueCheckFn = () => {
  throw new Error("emitDefaultValueCheck not yet registered");
};

export function registerEmitDefaultValueCheck(fn: EmitDefaultValueCheckFn): void {
  _emitDefaultValueCheck = fn;
}

export function emitDefaultValueCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fieldType: ValType,
  localIdx: number,
  initializer: ts.Expression,
  targetType?: ValType,
): void {
  _emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, initializer, targetType);
}

// ── emitArgumentsObject ───────────────────────────────────────────────

type EmitArgumentsObjectFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
) => void;

let _emitArgumentsObject: EmitArgumentsObjectFn = () => {
  throw new Error("emitArgumentsObject not yet registered");
};

export function registerEmitArgumentsObject(fn: EmitArgumentsObjectFn): void {
  _emitArgumentsObject = fn;
}

export function emitArgumentsObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
): void {
  _emitArgumentsObject(ctx, fctx, paramTypes, paramOffset);
}

// ── compileStringLiteral ──────────────────────────────────────────────

type CompileStringLiteralFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
  node?: ts.Node,
) => ValType | null;

let _compileStringLiteral: CompileStringLiteralFn = () => {
  throw new Error("compileStringLiteral not yet registered");
};

export function registerCompileStringLiteral(fn: CompileStringLiteralFn): void {
  _compileStringLiteral = fn;
}

export function compileStringLiteral(
  ctx: CodegenContext,
  fctx: FunctionContext,
  value: string,
  node?: ts.Node,
): ValType | null {
  return _compileStringLiteral(ctx, fctx, value, node);
}

// ── compileSuperPropertyAccess ────────────────────────────────────────

type CompileSuperPropertyAccessFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
) => ValType | null;

let _compileSuperPropertyAccess: CompileSuperPropertyAccessFn = () => {
  throw new Error("compileSuperPropertyAccess not yet registered");
};

export function registerCompileSuperPropertyAccess(fn: CompileSuperPropertyAccessFn): void {
  _compileSuperPropertyAccess = fn;
}

export function compileSuperPropertyAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | null {
  return _compileSuperPropertyAccess(ctx, fctx, expr, propName);
}

// ── compileSuperElementAccess ─────────────────────────────────────────

type CompileSuperElementAccessFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
) => ValType | null;

let _compileSuperElementAccess: CompileSuperElementAccessFn = () => {
  throw new Error("compileSuperElementAccess not yet registered");
};

export function registerCompileSuperElementAccess(fn: CompileSuperElementAccessFn): void {
  _compileSuperElementAccess = fn;
}

export function compileSuperElementAccess(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | null {
  return _compileSuperElementAccess(ctx, fctx, expr);
}

// ── emitBoundsCheckedArrayGet registration ────────────────────────────
// (delegate stub already existed but was never registered — fixed here)

// ── resolveEnclosingClassName registration ────────────────────────────
// (delegate stub already existed but was never registered — fixed here)

// ── addStringImports ─────────────────────────────────────────────────
// Delegate to break circular dependency: any-helpers.ts needs string
// imports but addStringImports lives in index.ts which imports any-helpers.

type AddStringImportsFn = (ctx: CodegenContext) => void;

let _addStringImports: AddStringImportsFn = () => {
  // No-op before registration — standalone mode may not have string imports
};

export function registerAddStringImports(fn: AddStringImportsFn): void {
  _addStringImports = fn;
}

export function addStringImportsDelegate(ctx: CodegenContext): void {
  _addStringImports(ctx);
}
