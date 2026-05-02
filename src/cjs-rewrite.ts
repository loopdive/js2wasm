// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// CommonJS `require()` → ESM import rewrite (#1279).
//
// Phase 1: detect static `const X = require('Y')` and `const { a, b } = require('Y')`
// patterns at module top-level and rewrite them to ESM `import` declarations. After
// rewrite, the existing import resolver (`resolveAllImports`), preprocessor
// (`preprocessImports`) and TypeScript-based multi-source analyzer all see them as
// regular ESM imports and link them correctly.
//
// We deliberately keep this conservative — only top-level `const` declarations whose
// initializer is a direct call to `require` with a single string-literal argument.
// Anything else (dynamic specifiers, `let`/`var`, nested scopes, default-value
// destructuring, `require(...).foo` chained access) is left untouched so we don't
// silently change semantics.

import ts from "typescript";

/** A single require() call rewrite plan. */
interface RequireRewrite {
  /** Position in the original source where the variable statement starts. */
  start: number;
  /** Position in the original source where the variable statement ends. */
  end: number;
  /** The replacement text (an ESM import declaration). */
  text: string;
}

/**
 * Rewrite top-level `const X = require('Y')` and `const { ... } = require('Y')` patterns
 * to ESM `import` declarations.
 *
 * Returns the original source unchanged if no top-level require() calls are present.
 */
export function rewriteCjsRequire(source: string): string {
  // Cheap pre-check: if the source doesn't even contain `require(`, skip parsing.
  if (!source.includes("require(")) return source;

  const sf = ts.createSourceFile("__cjs_rewrite__.ts", source, ts.ScriptTarget.Latest, true);
  const rewrites: RequireRewrite[] = [];

  for (const stmt of sf.statements) {
    const rewrite = tryRewriteStatement(stmt, sf);
    if (rewrite) rewrites.push(rewrite);
  }

  if (rewrites.length === 0) return source;

  // Apply rewrites in reverse order so positions stay valid.
  rewrites.sort((a, b) => b.start - a.start);
  let result = source;
  for (const r of rewrites) {
    result = result.substring(0, r.start) + r.text + result.substring(r.end);
  }
  return result;
}

/**
 * Inspect a top-level statement and, if it is a recognized CJS require() pattern,
 * return a rewrite plan that replaces it with an ESM import declaration.
 */
function tryRewriteStatement(stmt: ts.Statement, sf: ts.SourceFile): RequireRewrite | null {
  if (!ts.isVariableStatement(stmt)) return null;
  // Only `const X = require(...)` — never `let`/`var`, since those have different
  // semantics (mutable rebinding) that ESM imports can't express.
  const flags = stmt.declarationList.flags & ts.NodeFlags.BlockScoped;
  if (!(flags & ts.NodeFlags.Const)) return null;

  // Single-declaration form only. `const a = require('a'), b = require('b')` is uncommon
  // in CJS code and keeping it as a single rewrite is awkward — skip for now.
  if (stmt.declarationList.declarations.length !== 1) return null;
  const decl = stmt.declarationList.declarations[0];
  if (!decl.initializer) return null;

  const moduleSpec = extractRequireSpecifier(decl.initializer);
  if (moduleSpec === null) return null;

  // Now look at the binding pattern to decide between default-import and named-import.
  if (ts.isIdentifier(decl.name)) {
    // const X = require('Y') → import X from 'Y'
    const importText = `import ${decl.name.text} from ${JSON.stringify(moduleSpec)};`;
    return { start: stmt.getStart(sf), end: stmt.end, text: importText };
  }

  if (ts.isObjectBindingPattern(decl.name)) {
    // const { a, b: c } = require('Y') → import { a, b as c } from 'Y'
    // We only support the simple cases — no default values, no rest patterns,
    // no nested destructuring. Anything more complex bails out and the original
    // statement is preserved.
    const named: string[] = [];
    for (const el of decl.name.elements) {
      // Rest element: `const { ...rest } = require(...)` — not expressible in ESM.
      if (el.dotDotDotToken) return null;
      // Default initializer: `const { a = 1 } = require(...)` — not expressible.
      if (el.initializer) return null;
      // The binding target must be a plain identifier.
      if (!ts.isIdentifier(el.name)) return null;
      const localName = el.name.text;
      // `propertyName` is set when the source uses `b: c` aliasing.
      if (el.propertyName) {
        if (!ts.isIdentifier(el.propertyName)) return null;
        // ESM import binding names must be valid JS identifiers; computed keys would
        // not parse anyway because we already require an identifier propertyName.
        named.push(`${el.propertyName.text} as ${localName}`);
      } else {
        named.push(localName);
      }
    }
    if (named.length === 0) {
      // Empty destructuring is legal but pointless; treat as a side-effect import.
      const importText = `import ${JSON.stringify(moduleSpec)};`;
      return { start: stmt.getStart(sf), end: stmt.end, text: importText };
    }
    const importText = `import { ${named.join(", ")} } from ${JSON.stringify(moduleSpec)};`;
    return { start: stmt.getStart(sf), end: stmt.end, text: importText };
  }

  // Array destructuring or other patterns — leave alone.
  return null;
}

/**
 * If `expr` is `require('literal')`, return the literal string. Otherwise null.
 */
function extractRequireSpecifier(expr: ts.Expression): string | null {
  if (!ts.isCallExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "require") return null;
  if (expr.arguments.length !== 1) return null;
  const arg = expr.arguments[0];
  if (!ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) return null;
  return arg.text;
}
