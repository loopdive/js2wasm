---
id: 568
title: "- Wasm validation: local.set type mismatch (198 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-03-19
priority: high
feasibility: medium
goal: compilable
test262_ce: 198
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "emitCoercedLocalSet -- handle different struct type indices by updating local type"
      - "compileAssignment -- handle different struct type indices by updating local type"
---
# #568 -- Wasm validation: local.set type mismatch (198 CE)

## Status: review

## Problem

435 tests in the older test262 run failed with Wasm validation errors like:
`local.set[0] expected type (ref 8), found struct.new of type (ref 13)`

The root cause: when a variable (especially a `var` re-declaration) is assigned an object literal
with a different shape than its original declaration, `struct.new` produces a ref to a different
struct type than what the local was declared as.

The dominant pattern (400+ of 435 cases) was `(ref X) <- (ref Y)` where X and Y are different
struct type indices.

## Implementation Summary

### What was done

1. Extended `emitCoercedLocalSet` in expressions.ts to handle the case where both the stack type
   and local type are ref/ref_null but have different typeIdx values. When `coerceType` cannot
   insert any coercion instructions (because the struct types are unrelated), the local's declared
   type is updated to match the stack type via the new `updateLocalType` helper.

2. Added `updateLocalType` helper function that updates a local's (or param's) declared type to
   a new type.

3. Fixed `compileAssignment` in expressions.ts to apply the same pattern: when `coerceType` emits
   nothing for different struct ref types, update the local type before emitting `local.tee`.

### Files changed
- `src/codegen/expressions.ts`

### What worked
- Updating local types instead of trying to cast between unrelated struct types
- Checking if `coerceType` emitted any instructions via body length comparison

## Complexity: S
