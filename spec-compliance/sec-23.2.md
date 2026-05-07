# §23.2 TypedArray Objects

**Spec**: https://tc39.es/ecma262/#sec-typedarray-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/TypedArray`, `built-ins/TypedArrayConstructors`, `built-ins/Uint8Array`
**Coverage**: 1790 / 2242 pass (79.8%) — 343 fail, 109 skip
**Top error buckets**: type_error=156, assertion_fail=106, other=30

## What the spec requires

All 11 TypedArray constructors (Int8/16/32, Uint8/16/32, Uint8Clamped, Float32/64, BigInt64/Uint64) and the abstract %TypedArray% prototype methods are implemented. ArrayBuffer-backed.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts`
- `src/codegen/registry`

## Gap

TypedArray prototype: 1200/1438 (83.4%). Uint8Array.fromBase64/fromHex (newer methods): 31/68 (45.6%). %TypedArray% generic algorithms (sort, copyWithin, set) have detached-buffer guards missing on some paths.

## Issues filed / referenced

- [#1350](../plan/issues/sprints/50/1350-*.md)
