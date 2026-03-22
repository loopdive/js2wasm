/**
 * Shared types, constants, and utility functions for codegen modules.
 *
 * This module breaks circular dependencies between expressions.ts and
 * extracted feature modules (property-access.ts, etc.) by providing
 * core items that both need.  compileExpression is registered at startup
 * via setCompileExpression().
 */

import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import type { ValType } from "../ir/types.js";

// ── Sentinel for void expressions ────────────────────────────────────

/** Sentinel: expression compiled successfully but produces no value (void) */
export const VOID_RESULT = Symbol("void");
export type InnerResult = ValType | null | typeof VOID_RESULT;

// ── compileExpression delegate ───────────────────────────────────────

type CompileExpressionFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
) => ValType | null;

let _compileExpression: CompileExpressionFn | null = null;

/** Register the compileExpression implementation (called once from expressions.ts) */
export function setCompileExpression(fn: CompileExpressionFn): void {
  _compileExpression = fn;
}

/** Compile an expression — delegates to the registered implementation */
export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  if (!_compileExpression) {
    throw new Error("compileExpression not registered — call setCompileExpression first");
  }
  return _compileExpression(ctx, fctx, expr, expectedType);
}

// ── Utility functions ────────────────────────────────────────────────

/** Check if two ValTypes are structurally equal */
export function valTypesMatch(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") &&
      (b.kind === "ref" || b.kind === "ref_null")) {
    return (a as { typeIdx: number }).typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

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
