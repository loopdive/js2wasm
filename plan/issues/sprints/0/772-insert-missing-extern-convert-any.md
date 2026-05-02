---
id: 772
title: "- Insert missing extern.convert_any at call sites (1,299 CE)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-03-23
priority: critical
feasibility: easy
goal: compilable
test262_ce: 1299
---
# #772 -- Insert missing extern.convert_any at call sites (1,299 CE)

## Status: done

## Problem

1,299 tests fail with "call[0] expected type externref, found ref" — the compiler pushes a struct ref argument but the function parameter is typed as externref. Missing `extern.convert_any` coercion at the call site.

## Implementation Summary

Resolved as part of the broader call type mismatch fix (task #5 in compilable-w2 team). Two complementary changes:

1. **`src/codegen/expressions.ts`**: Added `getWasmFuncReturnType()` helper that inspects actual Wasm function type definitions instead of relying on TS type inference. Applied at ~12 call return sites — ensures `coerceType()` receives accurate types and emits correct coercions including `extern.convert_any`.

2. **`src/codegen/property-access.ts`**: Fixed getter accessor return type resolution to check actual Wasm function return type first. Prevented `__unbox_number(f64)` validation errors when getter returns f64 but TS reports `any` (externref).

After fixes, 2,662-test sample shows **0 compile errors** (down from ~1,299 in this category).

### Files changed
- `src/codegen/expressions.ts` (getWasmFuncReturnType + 12 call return sites)
- `src/codegen/property-access.ts` (getter return type fix)
- `src/codegen/binary-ops.ts` (ref/externref → f64 coercion in tryFlattenBinaryChain)
