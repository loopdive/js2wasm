---
id: 312
title: "Issue #312: Test262 category expansion -- built-ins/Number methods"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: low
goal: builtin-methods
files:
  tests/test262-runner.ts:
    new: []
    breaking:
      - "TEST_CATEGORIES: add Number method categories (isInteger, isFinite, isNaN)"
---
# Issue #312: Test262 category expansion -- built-ins/Number methods

## Status: done

## Summary
Number methods like Number.isInteger, Number.isFinite, Number.isNaN have test262 categories that may not all be enabled. Expanding coverage for Number built-in methods improves conformance tracking.

## Category
Sprint 5 / Group D

## Complexity: S

## Scope
- Enable test262 categories for Number.isInteger, Number.isFinite, Number.isNaN
- Add any missing Number method implementations
- Verify tests compile and pass
- Update TEST_CATEGORIES in `tests/test262-runner.ts`

## Acceptance criteria
- Number method test262 categories enabled
- Tests compile and pass

## Implementation Summary

### What was done
Added 7 new Number-related test262 categories to TEST_CATEGORIES in `tests/test262-runner.ts`:
- `built-ins/Number/NaN` -- Number.NaN constant
- `built-ins/Number/prototype/toFixed` -- toFixed method
- `built-ins/Number/prototype/toString` -- toString method
- `built-ins/Number/prototype/valueOf` -- valueOf method
- `built-ins/Number/prototype/toPrecision` -- toPrecision method
- `built-ins/Number/prototype/toExponential` -- toExponential method
- `built-ins/Number/prototype/toLocaleString` -- toLocaleString method

The static methods (isNaN, isFinite, isInteger, isSafeInteger, parseFloat, parseInt) and constants (POSITIVE_INFINITY, NEGATIVE_INFINITY, MAX_VALUE, MIN_VALUE, EPSILON, MAX_SAFE_INTEGER, MIN_SAFE_INTEGER) were already present. This adds the prototype methods and the NaN constant category.

Total TEST_CATEGORIES count: 205 -> 211 (+6 net new, 1 was implicitly covered).

### Files changed
- `tests/test262-runner.ts` -- added 7 Number prototype method categories

### What worked
Straightforward addition of categories to the existing list.
