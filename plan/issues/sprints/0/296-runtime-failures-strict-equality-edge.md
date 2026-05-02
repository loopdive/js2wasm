---
id: 296
title: "Issue #296: Runtime failures -- strict equality edge cases"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: high
goal: compilable
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileBinaryExpression: fix strict equality for cross-type comparisons"
  src/codegen/index.ts:
    new:
      - "__any_strict_eq helper for strict equality with any-typed operands"
    breaking: []
---
# Issue #296: Runtime failures -- strict equality edge cases

## Status: done

## Summary
4 tests fail at runtime across strict-equals and strict-does-not-equals categories. Strict equality (===, !==) produces wrong results for edge cases like -0 === 0 (should be true), NaN === NaN (should be false), or cross-type comparisons.

## Category
Sprint 5 / Group B

## Complexity: S

## Scope
- Fix -0 === 0 to return true (both are f64 zero)
- Fix NaN === NaN to return false
- Ensure cross-type strict equality always returns false
- Update strict equality in `src/codegen/expressions.ts`

## Acceptance criteria
- -0 === 0 returns true
- NaN === NaN returns false
- All 4 strict equality failures resolved

## Implementation Summary

### What was done
1. **Cross-type strict equality for concrete types**: Added a check in the externref equality path of `compileBinaryExpression` that short-circuits to false/true when `===`/`!==` is used between operands of different known JS types (string vs number, string vs boolean, number vs boolean). Previously, the code treated `===` the same as `==`, incorrectly unboxing and comparing as f64.

2. **Strict equality for any-typed operands**: Added a new `__any_strict_eq` Wasm helper function in `index.ts` that differs from `__any_eq` by always returning 0 (false) when the AnyValue tags differ, instead of attempting cross-tag numeric coercion (which `__any_eq` does for loose equality). Updated `compileAnyBinaryDispatch` to use `__any_strict_eq` for `===`/`!==` operators.

3. **-0 === 0 and NaN === NaN**: These already worked correctly because Wasm's `f64.eq` instruction handles IEEE 754 semantics: -0 equals +0, and NaN is not equal to NaN. Confirmed by tests.

### What worked
- Wasm f64.eq already handles -0 and NaN correctly per IEEE 754
- The cross-type check uses TypeScript's type system to determine JS type kinds before comparison

### Files changed
- `src/codegen/expressions.ts` -- cross-type strict equality short-circuit in externref equality path; use `__any_strict_eq` for `===`/`!==` in any-typed dispatch
- `src/codegen/index.ts` -- new `__any_strict_eq` helper function
- `tests/equivalence/strict-equality-edge-cases.test.ts` -- 8 new equivalence tests

### Tests now passing
- All 8 strict equality edge case tests (NaN, -0, cross-type)
- No regressions in existing equality, comparison, binary, or fast-mode tests
