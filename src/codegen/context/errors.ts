/**
 * Shared codegen error reporting helpers.
 *
 * This module owns backend diagnostics plumbing that only depends on the
 * stable context layer.
 */
import ts from "typescript";
import type { CodegenContext } from "./types.js";

/** Extract {line, column} from a node, returning {0,0} if not available. */
function extractLocation(node: ts.Node): { line: number; column: number } {
  try {
    const sf = node.getSourceFile();
    if (sf) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart());
      return { line: line + 1, column: character + 1 };
    }
  } catch {
    // Fall through to {0,0}
  }
  return { line: 0, column: 0 };
}

/**
 * Report a compile error with source location extracted from the given AST node.
 * Falls back to ctx.lastKnownNode when the node lacks source file context.
 */
export function reportError(ctx: CodegenContext, node: ts.Node, message: string): void {
  let loc = extractLocation(node);
  // If the primary node yielded no location, try the last known good node
  if (loc.line === 0 && ctx.lastKnownNode && ctx.lastKnownNode !== node) {
    loc = extractLocation(ctx.lastKnownNode);
  }
  ctx.errors.push({ message, line: loc.line, column: loc.column });
}

/**
 * Report a compile error when no AST node is available.
 * Uses ctx.lastKnownNode for location if possible.
 */
export function reportErrorNoNode(ctx: CodegenContext, message: string): void {
  if (ctx.lastKnownNode) {
    const loc = extractLocation(ctx.lastKnownNode);
    ctx.errors.push({ message, line: loc.line, column: loc.column });
  } else {
    ctx.errors.push({ message, line: 0, column: 0 });
  }
}
