---
id: 294
title: "Issue #294: Runtime failures -- assignment expression evaluation order"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: high
goal: core-semantics
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileAssignment: fix assignment expression return value to return RHS value; fix evaluation order for complex assignment targets and chained assignments"
---
# Issue #294: Runtime failures -- assignment expression evaluation order

## Status: done

## Summary
7 tests in language/expressions/assignment fail at runtime. Assignment expressions return the wrong value or have incorrect evaluation order. The value of an assignment expression should be the assigned value, and the target should be evaluated before the value.

## Category
Sprint 5 / Group B

## Complexity: S

## Scope
- Fix assignment expression return value (should return the RHS value)
- Fix evaluation order for complex assignment targets
- Handle chained assignments (`a = b = c = 1`)
- Update assignment compilation in `src/codegen/expressions.ts`

## Acceptance criteria
- Assignment expressions return the correct value
- Evaluation order matches spec
- At least 5 runtime failures resolved

## Implementation Summary

### What was done
Fixed all assignment expression paths to return the RHS value instead of `VOID_RESULT`. Previously, property assignments (`obj.x = 5`), element assignments (`arr[i] = 5`), static property assignments, setter-based assignments, and extern property assignments all returned `VOID_RESULT`, meaning the assignment expression produced no value. This broke chained assignments (`a = obj.x = 5`) and assignment-as-expression patterns (`result = (obj.x = 5)`).

The fix saves the RHS value in a temp local via `local.tee` before the `struct.set`/`array.set`/`global.set`/`call` that consumes it, then re-pushes it with `local.get` so the assignment expression correctly yields its value.

### What worked
- All 7 new equivalence tests pass
- No regressions in existing compiler, codegen, or equivalence tests
- Statement-context assignments work correctly because the expression statement handler already emits `drop` for non-null results

### Files changed
- `src/codegen/expressions.ts` -- `compilePropertyAssignment`, `compileExternPropertySet`, `compileElementAssignment`: changed all `VOID_RESULT` returns to save+return the RHS value
- `tests/equivalence/assignment-expression-value.test.ts` -- new test file with 7 equivalence tests covering simple assignment return, chained assignments, property assignment return, assignment in expression/condition context
