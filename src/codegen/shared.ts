/**
 * Shared utilities for codegen modules.
 *
 * This module breaks circular dependencies: extracted modules (binary-ops,
 * closures, etc.) import compileExpression from here instead of from
 * expressions.ts. expressions.ts registers its implementation at startup.
 */
import ts from "typescript";
import type { CodegenContext, FunctionContext } from "./index.js";
import type { ValType } from "../ir/types.js";

// ── VOID_RESULT sentinel ─────────────────────────────────────────────

/** Sentinel: expression compiled successfully but produces no value (void) */
export const VOID_RESULT = Symbol("void");
export type InnerResult = ValType | null | typeof VOID_RESULT;

// ── compileExpression (registered by expressions.ts at import time) ──

type CompileExpressionFn = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
) => ValType | null;

let _compileExpression: CompileExpressionFn | null = null;

/**
 * Compile an expression. This delegates to the implementation registered
 * by expressions.ts. All extracted codegen modules should use this
 * instead of importing from expressions.ts directly.
 */
export function compileExpression(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
  expectedType?: ValType,
): ValType | null {
  if (!_compileExpression) throw new Error("compileExpression not registered");
  return _compileExpression(ctx, fctx, expr, expectedType);
}

/** Called by expressions.ts to register the real implementation. */
export function registerCompileExpression(fn: CompileExpressionFn): void {
  _compileExpression = fn;
}

// ── Source location helpers ──────────────────────────────────────────

export function getLine(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    return sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  } catch {
    return 0;
  }
}

export function getCol(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    return sf.getLineAndCharacterOfPosition(node.getStart()).character + 1;
  } catch {
    return 0;
  }
}

// ── Type comparison ─────────────────────────────────────────────────

export function valTypesMatch(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ("typeIdx" in a && "typeIdx" in b) return a.typeIdx === b.typeIdx;
  return true;
}
