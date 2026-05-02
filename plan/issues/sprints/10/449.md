---
id: 449
title: "Wasm validation: call_ref on null function reference (15 CE)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-03-18
priority: low
goal: core-semantics
test262_ce: 15
complexity: XS
files:
  src/codegen/expressions.ts:
    breaking:
      - "compileCallExpression -- call_ref requires non-null function reference"
---
# #449 -- Wasm validation: call_ref on null function reference (15 CE)

## Problem

15 tests fail Wasm validation because `call_ref` is used with a nullable function reference type. The `call_ref` instruction requires a non-null reference; the compiler must emit `ref.as_non_null` before `call_ref` when the function reference may be null.

Common causes:
- Closure variables that are declared but conditionally assigned
- Function parameters typed as optional
- struct.get on a field that holds a nullable function reference

## Priority: low (15 tests)

## Complexity: XS

## Acceptance criteria
- [x] All call_ref sites use ref.as_non_null on nullable function references
- [x] CE count for call_ref null reduced to zero

## Implementation Summary

### What was done
Added `ref.as_non_null` before every `call_ref` instruction emission in `src/codegen/expressions.ts`. This ensures that the funcref on the stack is guaranteed non-null before `call_ref` executes, satisfying Wasm validation requirements.

All ~30 `call_ref` emission sites were audited. Many already had `ref.cast` (non-null variant, opcode 0x16) preceding them, which produces a non-null reference. The `ref.as_non_null` is redundant in those cases but harmless -- it serves as a defensive guard. For any edge cases where the reference might be nullable (e.g., from struct.get on a nullable field), the `ref.as_non_null` provides the necessary null check.

### Sites modified
- valueOf closure call paths (coercion)
- compileDirectClosureCall
- compileCallExpression (multiple branches: identifier lookup, member expression, optional chaining)
- Tagged template literal closure calls
- Array method callbacks: filter, map, reduce, forEach, find, findIndex, some, every

### Files changed
- `src/codegen/expressions.ts` -- added `ref.as_non_null` before all `call_ref` instructions

### Tests
- All equivalence tests pass (no regressions)
