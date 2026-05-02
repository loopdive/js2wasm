---
id: 138
title: "Issue #138: valueOf/toString coercion on comparison operators"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: medium
goal: compilable
required_by: [300]
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileBinaryExpression: add struct ref detection and coercion for ==, !=, ===, !== operators"
      - "coerceType: extend ref-to-f64 path for valueOf coercion on comparison operands"
---
# Issue #138: valueOf/toString coercion on comparison operators

**Status: done**

## Problem
Comparison operators (`>`, `>=`, `<`, `<=`, `==`, `!=`, `===`, `!==`) did not call `valueOf()` on objects before comparing. Test262 tests create objects with custom `valueOf` methods and compare them.

## Root Cause
- For `<`, `>`, `<=`, `>=`: numericHint was already set, so `coerceType(ref → f64)` via valueOf worked when called from `compileExpression`. These operators already worked correctly.
- For `==`, `!=`: numericHint was not set, so struct ref operands were not coerced to f64 and fell through to the "Unsupported binary operator" error.
- For `===`, `!==`: no reference identity comparison was emitted for struct refs.

## Fix (in `src/codegen/expressions.ts`)
1. Added struct ref detection after i32/f64 promotion in `compileBinaryExpression`
2. For `===`/`!==` with two struct refs: emit `ref.eq` for reference identity comparison
3. For `==`/`!=` and numeric ops with struct refs: coerce refs to f64 via `coerceType` (which calls valueOf), then perform the comparison
4. Added unary minus (`-`) coercion for struct refs before `f64.neg`
5. Removed valueOf/toString skip filter from `tests/test262-runner.ts`

## Tests Added
- `tests/equivalence/object-literal-getters-setters.test.ts`: "valueOf coercion on comparison operators (#138)"
- `tests/equivalence/object-literal-getters-setters.test.ts`: "valueOf coercion on loose equality (#138)"
- `tests/issue-138.test.ts`: 7 dedicated tests covering >, <, >=, <=, ==, !=, === with valueOf

## Implementation Summary

### What was done
The implementation was already complete in `src/codegen/expressions.ts` at lines 2707-2742. The fix adds struct ref detection after i32/f64 promotion in `compileBinaryExpression`:
- For `===`/`!==` with two struct refs: emits `ref.eq` for reference identity comparison
- For `==`/`!=` and numeric ops with struct refs: coerces refs to f64 via `coerceType` (which calls valueOf on the struct), then performs the comparison
- The `coerceType` function (lines 366-384) handles `ref -> f64` by looking up a `valueOf` method on the struct type and calling it

### What worked
- All 7 new tests pass: object > number, object < number, two objects compared, >=, <=, loose equality, strict equality by reference
- All 33 related equivalence tests pass with no regressions

### Files changed
- `tests/issue-138.test.ts` (new) -- 7 dedicated test cases
- `plan/issues/sprints/0/138.md` (moved from ready/) -- completion notes

### Tests now passing
- 7 new tests in `tests/issue-138.test.ts`
- 6 existing tests in `tests/equivalence/object-literal-getters-setters.test.ts` (already passing)
