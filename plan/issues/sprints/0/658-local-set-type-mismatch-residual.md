---
id: 658
title: "local.set type mismatch residual (659 CE)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: core-semantics
depends_on: [625]
test262_ce: 659
files:
  src/codegen/index.ts:
    breaking:
      - "coerce values before local.set in more codepaths"
---
# #658 — local.set type mismatch residual (659 CE)

## Status: review

659 tests fail with local.set type mismatches. #625 fixed the simple cases but 659 remain — deeper coercion gaps between ref types, especially in generator/async contexts.

## Complexity: M

## Root Cause Analysis

All 659 errors were `local.set[0]` — always targeting the first local variable. The root cause is a type mismatch between:
1. The struct field type produced by `struct.get` (or array element type from `array.get`)
2. The local's declared type, which was pre-allocated by `ensureBindingLocals()` using the TypeScript checker's resolved type

`ensureBindingLocals()` resolves types from the TS checker (e.g., `x = 23` resolves to `number` -> `f64`), but the tuple struct field might have a different Wasm type (e.g., `i32` for a hole/undefined sentinel). The destructuring codegen then does `struct.get` (producing the field type) followed by `local.set` to the local (expecting the TS-resolved type), causing a Wasm validation error.

### Top patterns (from test262 results):
- **96 CE**: `expected f64, found struct.get of type i32` — tuple field is i32, binding is f64
- **91 CE**: `expected externref, found ref.null of (ref null 0)` — closure captured ref.null
- **72 CE**: `expected i32, found struct.get of type externref` — tuple field is externref, binding is i32
- **60 CE**: `expected (ref null 1), found struct.get of type externref`
- **34 CE**: `expected i32, found f64.convert_i32_s`

## Implementation

Added `coerceType()` calls before `local.set` in three parameter destructuring paths in `src/codegen/index.ts`:

1. **Tuple struct destructuring** (`destructureParamArray`): After `struct.get` on tuple fields, coerce `fieldType` to the local's declared type.
2. **Vec array destructuring** (`destructureParamArray`): After `emitBoundsCheckedArrayGet`, coerce `elemType` to the local's declared type.
3. **Object destructuring** (`destructureParamObject`): After `struct.get` on struct fields, coerce `fieldType` to the local's declared type.

All three sites use `getLocalType()` to check the actual local type and `valTypesMatch()` to determine if coercion is needed.

## Files Changed
- `src/codegen/index.ts` — 3 coercion insertions in destructuring paths
- `tests/equivalence/destructuring-type-coercion.test.ts` — 4 new tests
