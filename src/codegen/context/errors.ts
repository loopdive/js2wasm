/**
 * Shared codegen error reporting helpers.
 *
 * This module owns backend diagnostics plumbing that only depends on the
 * stable context layer.
 */
import ts from "typescript";
import type { CodegenContext } from "./types.js";

export function reportError(ctx: CodegenContext, node: ts.Node, message: string): void {
  try {
    const sf = node.getSourceFile();
    if (sf) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      ctx.errors.push({ message, line: line + 1, column: character + 1 });
    } else {
      ctx.errors.push({ message, line: 0, column: 0 });
    }
  } catch {
    ctx.errors.push({ message, line: 0, column: 0 });
  }
}
