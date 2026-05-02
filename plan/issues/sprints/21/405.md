---
id: 405
title: "Internal compiler errors on unexpected AST shapes (64 CE)"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-03-16
goal: compilable
---
# Issue #405: Internal compiler errors on unexpected AST shapes

## Problem
64 tests crash with "Cannot read properties of undefined". The compiler accesses
properties on AST nodes without null checks, causing internal compiler errors
instead of graceful fallbacks.

## Implementation Summary

### What was done
Added defensive null/undefined checks at crash-prone sites in the codegen layer
to prevent "Cannot read properties of undefined" errors. The approach was
targeted null checks rather than broad try/catch, following the issue guidance.

### Categories of fixes

1. **Unsafe `(node.name as ts.Identifier).text` casts in destructuring code**
   (expressions.ts, statements.ts): Property names in destructuring patterns
   could be ComputedPropertyName, StringLiteral, or NumericLiteral -- not just
   Identifier. Added safe name extraction with type guards and `continue` on
   unsupported patterns.

2. **Unsafe `(element.name as ts.Identifier).text` casts in binding patterns**
   (statements.ts): Added `ts.isIdentifier(element.name)` checks before
   accessing `.text` in array/object destructuring, for-of loops, and nested
   patterns.

3. **Unsafe for-of/for-in loop variable extraction** (statements.ts): Loop
   variable declarations like `for (x of arr)` assumed `stmt.initializer` was
   always an Identifier. Added `ts.isIdentifier()` guards with fallbacks for
   other expression types.

4. **`getLine`/`getCol` crash protection** (expressions.ts, statements.ts,
   index.ts): `node.getStart()` can throw for synthetic nodes (e.g., from
   `ts.factory.create*`). Wrapped in try/catch to return 0 instead of crashing.

5. **Unsafe `localMap.get()!` non-null assertions** (statements.ts): Changed
   `fctx.localMap.get(name)!` to safe access with `undefined` check and
   `continue` to skip when the local doesn't exist.

6. **Safe function parameter name extraction** (statements.ts): Changed
   `(p.name as ts.Identifier).text` to `ts.isIdentifier(p.name) ? p.name.text
   : \`__param${i}\`` for function declaration parameters that could use
   destructuring patterns.

### Files changed
- `src/codegen/expressions.ts` -- 3 fixes (property name casts, getLine/getCol)
- `src/codegen/statements.ts` -- 14 fixes (destructuring, for-of/for-in, localMap, params, getLine/getCol)
- `src/codegen/index.ts` -- 2 fixes (reportError, getSourcePos)

### Test results
- Equivalence tests: 634 pass, 7 fail (all pre-existing), 0 regressions
- Destructuring, control-flow, for-of, for-in, spread-rest: all passing
