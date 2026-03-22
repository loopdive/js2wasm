/**
 * Shared utilities for codegen modules.
 *
 * This module exists to break circular dependencies between expressions.ts
 * and extracted modules (array-methods.ts, etc.). Functions that are needed
 * by both expressions.ts and extracted modules live here. The key trick is
 * the `compileExpression` delegate: expressions.ts registers its real
 * implementation at module load time, and extracted modules call the delegate.
 */
import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import type { ValType } from "../ir/types.js";

// ── VOID_RESULT sentinel ──────────────────────────────────────────────

/** Sentinel: expression compiled successfully but produces no value (void) */
export const VOID_RESULT: unique symbol = Symbol("void");
export type InnerResult = ValType | null | typeof VOID_RESULT;

// ── compileExpression delegate ────────────────────────────────────────

type CompileExpressionFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
) => ValType | null;

let _compileExpression: CompileExpressionFn | null = null;

/**
 * Register the real compileExpression implementation.
 * Called once by expressions.ts at module load time.
 */
export function registerCompileExpression(fn: CompileExpressionFn): void {
  _compileExpression = fn;
}

/**
 * Compile an expression. Delegates to the real implementation registered
 * by expressions.ts. Throws if called before registration (should never
 * happen in practice since expressions.ts is always loaded first).
 */
export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  if (!_compileExpression) {
    throw new Error("compileExpression not yet registered (circular dep issue)");
  }
  return _compileExpression(ctx, fctx, expr, expectedType);
}

// ── compileArrowAsClosure delegate ────────────────────────────────────

type CompileArrowAsClosureFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
) => ValType | null;

let _compileArrowAsClosure: CompileArrowAsClosureFn | null = null;

export function registerCompileArrowAsClosure(fn: CompileArrowAsClosureFn): void {
  _compileArrowAsClosure = fn;
}

export function compileArrowAsClosure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arrow: ts.ArrowFunction | ts.FunctionExpression,
): ValType | null {
  if (!_compileArrowAsClosure) {
    throw new Error("compileArrowAsClosure not yet registered (circular dep issue)");
  }
  return _compileArrowAsClosure(ctx, fctx, arrow);
}

// ── valTypesMatch ─────────────────────────────────────────────────────

/** Check if two ValTypes are structurally equal */
export function valTypesMatch(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") &&
      (b.kind === "ref" || b.kind === "ref_null")) {
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
