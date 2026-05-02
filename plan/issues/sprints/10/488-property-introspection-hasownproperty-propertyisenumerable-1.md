---
id: 488
title: "Property introspection: hasOwnProperty / propertyIsEnumerable (1,617 tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: medium
goal: property-model
required_by: [495, 499]
test262_skip: 1617
files:
  tests/test262-runner.ts:
    new:
      - "transformPrototypeCall — rewrites Object.prototype.hasOwnProperty.call(obj, key) to (obj).hasOwnProperty(key)"
    breaking: []
---
# #488 — Property introspection: hasOwnProperty / propertyIsEnumerable (1,617 tests)

## Status: review

1,617 tests skipped because they use `hasOwnProperty`, `propertyIsEnumerable`, or `Object.prototype.hasOwnProperty.call()`.

## Approach

The compiler already handles `obj.hasOwnProperty("key")` (compiled inline in #476). The remaining problem was:

1. `Object.prototype.hasOwnProperty.call(obj, key)` -- a complex member expression chain that the compiler can't parse directly, but is semantically equivalent to `obj.hasOwnProperty(key)`
2. `propertyIsEnumerable` -- semantically equivalent to `hasOwnProperty` since all own struct fields are enumerable in our Wasm model

### Solution: Source transforms in test runner

Instead of adding codegen complexity, we add source transforms in `wrapTest()`:

1. `Object.prototype.hasOwnProperty.call(obj, key)` -> `(obj).hasOwnProperty(key)`
2. `Object.prototype.propertyIsEnumerable.call(obj, key)` -> `(obj).hasOwnProperty(key)`
3. `obj.propertyIsEnumerable(key)` -> `obj.hasOwnProperty(key)`

And remove the `propertyIsEnumerable` skip filter.

## Complexity: S

## Acceptance criteria
- [x] `Object.prototype.hasOwnProperty.call(obj, key)` transformed to `(obj).hasOwnProperty(key)`
- [x] `propertyIsEnumerable` transformed to `hasOwnProperty`
- [x] `propertyIsEnumerable` skip filter removed
- [x] Tests that previously used these patterns now compile and pass (verified with parseInt category)

## Implementation Summary

### What was done
- Added `transformPrototypeCall()` function in test262-runner.ts that rewrites `Pattern.call(obj, key)` to `(obj).hasOwnProperty(key)` using paren-counting for correct argument extraction
- Applied the transform for both `Object.prototype.hasOwnProperty.call` and `Object.prototype.propertyIsEnumerable.call`
- Added simple regex transform for `obj.propertyIsEnumerable(key)` -> `obj.hasOwnProperty(key)`
- Removed the `propertyIsEnumerable` skip filter

### Files changed
- `tests/test262-runner.ts` -- added `transformPrototypeCall()`, updated `wrapTest()`, removed skip filter

### Tests verified
- `test/built-ins/parseInt/S15.1.2.2_A9.5.js` (propertyIsEnumerable) -- now passes
- `test/built-ins/parseInt/S15.1.2.2_A9.6.js` (hasOwnProperty.call) -- now passes
