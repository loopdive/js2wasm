---
id: 362
title: "typeof on member expressions"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-03-16
priority: medium
goal: builtin-methods
---
# typeof on member expressions

## Problem
16 test262 tests use `typeof` on member expressions (e.g., `typeof obj.prop`). These were being skipped by a filter in `test262-runner.ts` even though the compiler already handles them correctly via `ctx.checker.getTypeAtLocation()`.

## Implementation Summary

### What was done
1. Removed the skip filter in `tests/test262-runner.ts` that blocked tests using `typeof` on member expressions
2. Added equivalence tests covering typeof on member expressions for number, string, boolean, function, object, and nested properties

### What worked
The compiler's `compileTypeofExpression` function already correctly handles member expressions. The TypeScript type checker's `getTypeAtLocation()` resolves types for any expression including `PropertyAccessExpression` and `ElementAccessExpression`. No codegen changes were needed.

### Files changed
- `tests/test262-runner.ts` -- removed typeof member expression skip filter
- `tests/equivalence/typeof-member-expression.test.ts` -- new equivalence tests (6 tests)

### Tests now passing
- 6 new equivalence tests for typeof on member expressions
- ~16 test262 tests that were previously skipped
