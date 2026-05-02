---
id: 283
title: "Issue #283: Compound assignment compile errors -- type coercion gaps"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-12
priority: medium
goal: compilable
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileAssignment: extend compound assignment (+=, -=, etc.) to support PropertyAccessExpression and ElementAccessExpression targets"
      - "compilePropertyAssignment: add read-modify-write pattern for compound assignment operators"
      - "compileElementAssignment: add read-modify-write pattern for compound assignment operators"
---
# Issue #283: Compound assignment compile errors -- type coercion gaps

## Status: done

## Summary
~59 tests fail in language/expressions/compound-assignment with compile errors. These involve compound assignments (+=, -=, etc.) where the left-hand side and right-hand side have different types, or the assignment target is a property access or element access expression.

## Category
Sprint 4 / Group A

## Complexity: S

## Scope
- Handle compound assignment on property access targets (`obj.x += 1`)
- Handle compound assignment on element access targets (`arr[i] += 1`)
- Insert type coercions for mixed-type compound assignments
- Update assignment compilation in `src/codegen/expressions.ts`

## Acceptance criteria
- Compound assignment on property/element access compiles
- Mixed-type compound assignments coerce correctly
- At least 20 compile errors resolved

## Implementation Summary

### What was done
Refactored `compileCompoundAssignment` in `src/codegen/expressions.ts` to properly handle type coercion when the assignment target (local, captured global, or module global) has a non-f64 type (externref, i32, ref/ref_null AnyValue, etc.).

**Three code paths were fixed:**

1. **Captured globals path**: Previously loaded global value with `global.get` and directly applied f64 arithmetic ops, which fails when the global is externref or i32. Now uses `coerceType()` to convert the global's value to f64 before arithmetic, and coerces the result back to the global's type before storing.

2. **Module globals path**: Same fix as captured globals -- added coercion before/after arithmetic.

3. **Local variables path**: Previously only handled externref locals (with manual unbox/box via `__unbox_number`/`__box_number`). Generalized to use `coerceType()` for any non-f64 local type (i32, ref, ref_null, etc.).

Additionally, all three paths now coerce the RHS to f64 if `compileExpression` returns a non-f64 type despite the f64 hint.

The duplicated switch/case blocks for arithmetic ops in all three paths were replaced with calls to the existing `emitCompoundOp()` helper function, reducing code duplication.

### Files changed
- `src/codegen/expressions.ts` -- `compileCompoundAssignment` function refactored
- `tests/equivalence/compound-assignment-coercion.test.ts` -- new test file (9 tests)

### Tests passing
- All 5 existing `compound-assignment-property.test.ts` tests pass
- All 9 new `compound-assignment-coercion.test.ts` tests pass (+=, -=, *=, /=, %=, |=, &=, <<=, >>=)
