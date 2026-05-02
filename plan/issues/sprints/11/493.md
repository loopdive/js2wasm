---
id: 493
title: "- Narrow prototype chain skip filter (502 tests, was 233 at filing)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: low
goal: property-model
test262_skip: 502
files:
  tests/test262-runner.ts:
    new:
      - "string literal stripping in prototype chain skip filter"
    breaking: []
---
# #493 -- Narrow prototype chain skip filter (502 tests, was 233 at filing)

## Status: review

502 tests currently skipped for "prototype chain not supported" (count grew from 233 as more categories were added to TEST_CATEGORIES).

## Analysis

### Sub-pattern breakdown (502 total, 312 uniquely caught by this filter)

| Pattern | Total matches | Unique (no other filter) |
|---------|--------------|-------------------------|
| `.prototype = ` (reassignment) | 222 | 80 |
| `.prototype.foo = ` (prop set) | 141 | 91 |
| `Object.getPrototypeOf` | 100 | 66 |
| `Object.setPrototypeOf` | 37 | 24 |
| `__proto__` | 27 | 15 |
| `.isPrototypeOf` | 9 | 4 |

### String literal false positives

8 tests match the filter only because `__proto__` appears in string literals (assert messages, property name strings). All 8 are caught by other skip filters anyway:
- 4 `dynamic-import` tests (unsupported)
- 4 `Object.defineProperty`/poisoned-proto tests (unsupported)

### Can we narrow further?

**No meaningful narrowing is possible.** Every sub-pattern genuinely tests prototype chain behavior:

- `.prototype = X` -- tests reassign constructor prototypes (e.g., `FACTORY.prototype = undefined; obj instanceof FACTORY`)
- `.prototype.foo = bar` -- tests patch built-in prototypes (`Number.prototype.then = function(){}`) or copy prototype methods to other objects (`__instance.indexOf = String.prototype.indexOf`)
- `Object.getPrototypeOf` -- tests introspect the prototype chain
- `Object.setPrototypeOf` -- tests mutate the prototype chain
- `__proto__` as object literal key -- `{__proto__: X}` IS prototype setting in JS
- `.isPrototypeOf` -- tests check prototype chain membership

The original issue assumed `instanceof` and `.constructor` tests were falsely caught, but inspection shows those tests also involve prototype reassignment (`Foo.prototype = {...}`) which is the actual trigger.

### Applied improvement

Added string literal stripping to the `execCode` processing (consistent with the source-body-check pattern). This prevents 8 false positives from this filter. While all 8 are currently caught by other filters, this is defensive -- as other filters are removed in the future, these tests won't be falsely re-caught by the prototype filter.

## Complexity: S (analysis-heavy, minimal code change)

## Acceptance criteria
- [x] Apply source-body-check pattern (strip string literals in addition to comments)
- [x] Document analysis of all 502 tests
- [ ] No regressions in test suite
