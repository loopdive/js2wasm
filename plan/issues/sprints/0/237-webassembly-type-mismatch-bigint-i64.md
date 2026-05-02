---
id: 237
title: "Issue #237: WebAssembly type mismatch -- BigInt i64 vs externref"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: medium
goal: compilable
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "coerceType: add i64-to-externref conversion path (f64.convert_i64_s + __box_number)"
---
# Issue #237: WebAssembly type mismatch -- BigInt i64 vs externref

## Status: done

## Summary

170 tests fail at Wasm instantiation time with errors like "call[0] expected type externref, found i64.sub of type i64". These are BigInt-related tests where i64 values are passed to functions expecting externref (e.g., string concatenation, assertion functions).

## Root Cause

BigInt values are compiled as i64 in Wasm. When these values flow into externref-expecting contexts (like `assert.sameValue`, string concatenation with `+`, or any function that takes externref parameters), the Wasm validator rejects the type mismatch. The codegen needs to box i64 values into externref when passing to externref-typed parameters.

## Scope

- `src/codegen/expressions.ts` -- `coerceType` function, BigInt handling
- Tests affected: ~170 compile errors

## Expected Impact

Fixes ~170 Wasm validation errors, enabling BigInt tests to at least run.

## Suggested Approach

1. In `coerceType`, add a path for i64 -> externref:
   - Convert i64 to f64 via `f64.convert_i64_s`
   - Then box via `__box_number` (existing import)
   - This loses BigInt semantics but allows the tests to run
2. Alternatively, add a `__box_bigint` host import that wraps i64 into a JS BigInt externref
3. For string concatenation with BigInt, convert i64 to string via a new `__bigint_to_string` helper

## Acceptance Criteria

- [x] i64 values can flow into externref-typed parameters without Wasm validation error
- [x] BigInt assertion tests (`assert.sameValue(0n, 0n)`) pass validation
- [x] At least 100 compile errors resolved

## Complexity: M

## Implementation Summary

The fix was implemented in commit `0f62e2e8` which added i64 coercion paths for AnyValue boxing/unboxing in `coerceType`:

**What was done:**
- Added i64 -> AnyValue boxing: `f64.convert_i64_s` + `__any_box_f64` call (lines 211-219 in expressions.ts)
- Added AnyValue -> i64 unboxing: `__any_unbox_f64` call + `i64.trunc_sat_f64_s` (lines 241-249)
- The i64 -> externref path (`f64.convert_i64_s` + `__box_number`) was already present at lines 347-356
- The externref -> i64 path (`__unbox_number` + `i64.trunc_sat_f64_s`) was already present at lines 315-327
- Template expressions and string concatenation with `+` both handle i64 via `f64.convert_i64_s` + `number_toString`

**What worked:**
- Converting i64 through f64 as an intermediate step avoids needing a separate BigInt boxing mechanism
- All existing BigInt equivalence tests continue to pass
- The `compileExpression` function's expectedType parameter properly triggers coerceType for argument passing

**Files changed:**
- `src/codegen/expressions.ts` -- i64 coercion paths in coerceType
- `tests/issue-237.test.ts` -- test coverage for i64 boxing/unboxing
- `tests/equivalence/bigint-externref.test.ts` -- additional equivalence tests

**Tests passing:**
- All 15 existing BigInt equivalence tests pass
- 7 new BigInt externref coercion tests pass
- No regressions in the equivalence test suite (481 pass, 7 pre-existing failures unrelated)
