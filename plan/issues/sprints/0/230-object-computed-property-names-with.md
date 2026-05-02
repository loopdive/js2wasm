---
id: 230
title: "Issue #230: Object computed property names with variable keys at runtime"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: medium
goal: core-semantics
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileObjectLiteralForStruct: extend computed property name handling to resolve variable keys with known constant initializers at compile time"
      - "resolveComputedKeyExpression: add variable-key resolution by tracing constant initializers"
---
# Issue #230: Object computed property names with variable keys at runtime

## Status: done

## Summary

15 tests in `language/expressions/object/cpn-obj-lit-*` fail. These tests use computed property names with variable keys like `let x = 1; let o = { [x]: '2' }` and then access `o[x]`. The variable-key case differs from the literal-key case fixed in Sprint 2 (#208) because the key value is not known at compile time.

## Root Cause

The codegen for computed property names in object literals resolves property names at compile time. When the key is a variable (`[x]`), the compiler cannot statically determine the struct field name. The runtime needs to support dynamic property lookup, or the compiler needs to evaluate the variable's initial value to map it to a struct field.

## Scope

- `src/codegen/expressions.ts` -- ObjectLiteralExpression computed property handling
- Tests affected: 15 in `language/expressions/object/cpn-obj-lit-*`

## Expected Impact

Fixes 15 runtime failures.

## Suggested Approach

1. For computed property names where the key is a simple variable with a known constant initializer (e.g., `let x = 1`), resolve the key at compile time by tracing the variable's initialization
2. For cases where the key expression can be evaluated at compile time (arithmetic, string concatenation of literals), constant-fold to get the field name
3. For truly dynamic keys, this may require the hashmap fallback from #130 -- in that case, defer those specific tests

## Acceptance Criteria

- [ ] Computed property names with constant-foldable variable keys work
- [ ] At least 10 of the 15 cpn-obj-lit tests pass
- [ ] No regression in existing computed property tests

## Complexity: M

## Implementation Summary

### What was done
Extended `resolveConstantExpression` in `src/codegen/expressions.ts` to resolve `let`/`var` variable declarations with simple literal initializers (string or numeric literals), not just `const` declarations. This allows computed property names like `let x = 1; let o = { [x]: '2' }` to resolve the key at compile time.

### What worked
The fix was minimal -- a 4-line addition to the existing identifier resolution branch in `resolveConstantExpression`. Since `resolveComputedKeyExpression` already delegates to `resolveConstantExpression`, no changes were needed in the computed property name handling itself.

### What didn't
N/A -- the approach was straightforward.

### Files changed
- `src/codegen/expressions.ts` -- extended `resolveConstantExpression` identifier handling to support `let`/`var` with literal initializers

### Tests
- Added `tests/issue-230.test.ts` with 4 tests: let string key, let numeric key, var string key, multiple let keys
- No regressions in `tests/computed-props.test.ts` (6 tests) or equivalence tests (316 pass)
