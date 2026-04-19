// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";

/**
 * Module-level memo cache. WeakMap keys die with their ts.Node when the
 * TS program is discarded between compiles — no explicit reset needed.
 */
const cache = new WeakMap<ts.Node, boolean>();

/**
 * Check if a node tree references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 *
 * Uses iterative DFS to avoid stack overflow on deeply nested ASTs
 * (CI cgroup limits, #1085). Results are memoized so repeated calls on
 * overlapping subtrees collapse from O(N²) to O(N) total (#1086).
 */
export function bodyUsesArguments(node: ts.Node): boolean {
  const cached = cache.get(node);
  if (cached !== undefined) return cached;

  const stack: ts.Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (ts.isIdentifier(current) && current.text === "arguments") {
      cache.set(node, true);
      return true;
    }
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) {
      continue;
    }
    // Arrow functions do NOT have their own `arguments` — they inherit
    // the enclosing function's, so we must traverse into them.
    current.forEachChild((child) => {
      stack.push(child);
    });
  }
  cache.set(node, false);
  return false;
}
