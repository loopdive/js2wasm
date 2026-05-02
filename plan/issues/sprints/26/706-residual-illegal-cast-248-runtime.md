---
id: 706
title: "Residual illegal cast: 248 runtime failures"
status: done
created: 2026-03-21
updated: 2026-04-14
completed: 2026-03-21
priority: high
goal: spec-completeness
required_by: [726]
---
# Issue #706: Residual illegal cast — 248 runtime failures

## Problem

248 tests fail with "RuntimeError: illegal cast" — the compiler emits `ref.cast` to downcast from eqref/anyref to a specific struct type, but the runtime value is a different type.

Key affected areas:
- eval-code (78 tests): eval() returns values with different types than expected
- class statements (78): class expressions create objects with unexpected struct types
- expressions (76): iterator protocol objects have different layouts

## Root Cause

The `coerceType` function in `src/codegen/type-coercion.ts` emitted unguarded `ref.cast` instructions in several paths:
1. AnyValue unboxing: `ref $AnyValue -> ref $X` extracted the eqref refval field and blindly cast
2. Struct-to-struct: `ref $A -> ref $B` assumed subtypes but runtime types differed
3. `eqref/anyref -> ref`: blind downcast to target struct type
4. `externref -> ref` (backup path): blind downcast after `any.convert_extern`

## Fix

Replaced all unguarded `ref.cast` in `coerceType` with guarded patterns:

```wasm
;; Instead of: ref.cast $Target (traps on wrong type)
;; Use:
local.tee $tmp
ref.test $Target
if (result (ref_null $Target))
  local.get $tmp
  ref.cast_null $Target
else
  ref.null $Target
end
;; For non-nullable targets, follow with ref.as_non_null
```

Seven sites were guarded:
1. AnyValue unboxing `ref -> ref/ref_null` (two sites)
2. Struct-to-struct cast `ref/ref_null -> ref/ref_null`
3. `ref -> ref_null` with different typeIdx
4. `ref_null -> ref` (AnyValue and struct-to-struct)
5. `externref -> ref` (backup path)
6. `eqref/anyref -> ref`

## Implementation Summary

**What was done**: Added `ref.test` guards before every `ref.cast` in the `coerceType` function that could encounter polymorphic runtime types. The guard uses a temp local to save the value, tests with `ref.test`, and branches to either perform the cast (test passed) or push `ref.null` (test failed).

**Files changed**:
- `src/codegen/type-coercion.ts` — guarded 7 `ref.cast` sites in `coerceType`
- `tests/illegal-cast-guard.test.ts` — new test file for guarded cast behavior

**Tests**: All existing tests pass (no regressions). New test file with 3 tests verifying class instances, inheritance, and multiple class types work without illegal cast traps.
