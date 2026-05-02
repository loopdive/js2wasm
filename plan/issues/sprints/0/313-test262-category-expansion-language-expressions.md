---
id: 313
title: "Issue #313: Test262 category expansion -- language/expressions new categories"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: low
goal: spec-completeness
files:
  tests/test262-runner.ts:
    new: []
    breaking:
      - "TEST_CATEGORIES: add expression categories (optional-chaining, async-generator, dynamic-import, import.meta, super)"
---
# Issue #313: Test262 category expansion -- language/expressions new categories

## Status: done

## Summary
Several expression categories may not be in TEST_CATEGORIES yet: tagged-template, optional-chaining, nullish-coalescing, exponentiation, spread, typeof, void, delete-related. Adding these expands conformance coverage.

## Category
Sprint 5 / Group D

## Complexity: S

## Scope
- Audit which language/expressions categories are missing from TEST_CATEGORIES
- Add categories for implemented expression types
- Run and verify new categories
- Update TEST_CATEGORIES in `tests/test262-runner.ts`

## Acceptance criteria
- At least 5 new expression categories added
- Passing tests properly tracked

## Implementation Summary

### What was done
Audited all test262 `language/expressions/` directories against the existing TEST_CATEGORIES list. Found that many categories mentioned in the issue description (tagged-template, exponentiation, typeof, void, delete, coalesce/nullish-coalescing) were already present. Added the 5 remaining missing categories:

1. `language/expressions/optional-chaining`
2. `language/expressions/async-generator`
3. `language/expressions/dynamic-import`
4. `language/expressions/import.meta`
5. `language/expressions/super`

### What worked
All 5 categories register correctly in the runner. Currently most tests in these categories are filtered out by existing skip criteria (eval, prototype chain, etc.), but they are now tracked so tests will appear as feature support expands.

### Files changed
- `tests/test262-runner.ts` -- added 5 new expression categories to TEST_CATEGORIES

### Tests
No regressions. New categories verified with standalone runner.
