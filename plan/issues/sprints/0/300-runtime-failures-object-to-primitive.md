---
id: 300
title: "Issue #300: Runtime failures -- object to primitive conversion"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: high
goal: error-model
depends_on: [138, 139]
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "coerceType: complete valueOf/toString/Symbol.toPrimitive coercion chain for all arithmetic and template literal contexts"
---
# Issue #300: Runtime failures -- object to primitive conversion

## Status: done

## Summary
5 tests fail with "TypeError: Cannot convert object to primitive value" at runtime. When objects are used in arithmetic or comparison contexts, the runtime attempts to convert them to primitives via valueOf/toString but the coercion path is incomplete for some patterns.

## Category
Sprint 5 / Group B

## Complexity: M

## Scope
- Complete valueOf/toString coercion for all arithmetic contexts
- Handle objects in template literal interpolation
- Support Symbol.toPrimitive (or fall back to valueOf/toString chain)
- Update coercion logic in `src/codegen/expressions.ts`

## Acceptance criteria
- Objects with valueOf/toString coerce to primitives in all contexts
- All 5 TypeError failures resolved

## Implementation Summary

### What was done
1. **Template expression toString coercion**: Fixed both standard and fast-mode template expression handlers to use `coerceType()` instead of raw `extern.convert_any` when converting struct refs to externref. This ensures objects with a `toString()` method get properly converted via their toString method in template literal interpolation contexts (e.g. `` `${obj}` ``).

2. **Verified existing valueOf coercion**: The existing coerceType infrastructure (from issues #138/#139) already correctly handles:
   - Objects with valueOf() in arithmetic contexts (+, -, *, /)
   - Objects with valueOf() in comparison contexts (<, >, <=, >=)
   - Objects without valueOf producing NaN in numeric contexts
   - Objects with both valueOf and toString (valueOf used for numeric hint)
   - Struct ref → f64 coercion via class method valueOf (ClassName_valueOf)
   - Struct ref → f64 coercion via closure valueOf field
   - Struct ref → f64 coercion via eqref valueOf with dispatch

### What worked
- The existing coerceType function already had comprehensive valueOf handling for ref → f64 and toString handling for ref → externref. The main gap was in the template expression handlers which bypassed coerceType.

### What didn't work
- Symbol.toPrimitive is not yet supported (as noted in scope, this can be deferred).

### Files changed
- `src/codegen/expressions.ts` — template expression handlers now use coerceType for struct ref → externref
- `tests/issue-300.test.ts` — 7 new tests covering valueOf in numeric, comparison, and mixed contexts

### Tests now passing
- 7 new tests in `tests/issue-300.test.ts`
- All 26 equivalence tests continue to pass
- All existing tests pass (no regressions)
