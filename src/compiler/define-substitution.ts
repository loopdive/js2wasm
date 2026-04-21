// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Compile-time constant substitution.
 *
 * Replaces dotted identifier paths (e.g. `process.env.NODE_ENV`) with literal
 * values in source text before TypeScript parsing. This enables dead-branch
 * elimination when combined with constant-folding in codegen.
 *
 * Also handles `typeof <identifier>` forms: `typeof process` can be replaced
 * with `"undefined"` to eliminate environment-detection branches.
 */

/**
 * Apply compile-time define substitutions to source text.
 *
 * @param source - Original TypeScript/JavaScript source
 * @param defines - Map of dotted paths to replacement literals.
 *   Example: `{ "process.env.NODE_ENV": '"production"' }`
 * @returns Source with substitutions applied
 */
export function applyDefineSubstitutions(source: string, defines: Record<string, string>): string {
  if (!defines || Object.keys(defines).length === 0) return source;

  let result = source;

  // Sort keys by length (longest first) to avoid partial matches
  const keys = Object.keys(defines).sort((a, b) => b.length - a.length);

  for (const key of keys) {
    const replacement = defines[key]!;

    // Handle typeof forms: "typeof process" → replacement
    if (key.startsWith("typeof ")) {
      const ident = key.slice(7); // "typeof process" → "process"
      // Match `typeof <ident>` not preceded by a dot or alphanumeric
      const typeofPattern = new RegExp(`(?<![.\\w$])typeof\\s+${escapeRegExp(ident)}(?![\\w$])`, "g");
      result = result.replace(typeofPattern, replacement);
      continue;
    }

    // Build a regex that matches the dotted path as a standalone expression.
    // Must not be preceded by a dot, alphanumeric, $, or _ (to avoid matching
    // e.g. `foo.process.env.NODE_ENV`), and must not be followed by alphanumeric/$/_.
    const pattern = new RegExp(`(?<![.\\w$])${escapeRegExp(key)}(?![\\w$])`, "g");
    result = result.replace(pattern, replacement);
  }

  return result;
}

/**
 * Build the default define map for a given production/development mode.
 * This is the convenience path — users can also pass explicit defines.
 */
export function buildDefaultDefines(mode: "production" | "development"): Record<string, string> {
  return {
    "process.env.NODE_ENV": JSON.stringify(mode),
    "typeof process": JSON.stringify("undefined"),
    "typeof window": JSON.stringify("undefined"),
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
