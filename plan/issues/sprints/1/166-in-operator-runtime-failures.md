---
id: 166
title: "`in` operator runtime failures"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: contributor-readiness
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileBinaryExpression: add numeric literal key and runtime string comparison for in operator"
  src/codegen/index.ts:
    new:
      - "collectInExprStringLiterals() — pre-register struct field names for dynamic in expressions"
    breaking: []
---
# #166 — `in` operator runtime failures

## Status: done

## Problem
The `in` operator only handled string literal keys on struct types. Numeric literal keys (e.g. `0 in obj`) and dynamic/computed keys (e.g. variable `k in obj`) always returned false.

## Fix
- Added numeric literal key support by treating `ts.isNumericLiteral` the same as `ts.isStringLiteral` for static resolution
- Added runtime string comparison for dynamic keys: compiles a chain of `wasm:js-string equals` calls against each struct field name, OR-ing the results
- Added `collectInExprStringLiterals()` to pre-register struct field names as string constants when dynamic `in` expressions are detected

## Files changed
- `src/codegen/expressions.ts` — `compileBinaryExpression` `in` operator handling
- `src/codegen/index.ts` — added `collectInExprStringLiterals()` and call sites

## Complexity: S
