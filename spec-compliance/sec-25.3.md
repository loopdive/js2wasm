# §25.3 DataView Objects

**Spec**: https://tc39.es/ecma262/#sec-dataview-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/DataView`
**Coverage**: 410 / 561 pass (73.1%) — 112 fail, 39 skip
**Top error buckets**: assertion_fail=51, runtime_error=26, type_error=15

## What the spec requires

DataView wraps an ArrayBuffer with offset+length. .getInt8/16/32, .getUint8/16/32, .getFloat32/64, .setInt8/16/32 etc. are inlined to Wasm load/store with i32-bswap when little-endian flag set.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts`
- `src/codegen/registry`

## Gap

410/561 (73.1%). 26 runtime_error — likely byteLength bounds-checks on resizable buffers. BigInt64/BigUint64 view reads need i64↔BigInt host bridge.

## Issues filed / referenced

- [#1351](../plan/issues/sprints/50/1351-*.md)
- [#1350](../plan/issues/sprints/50/1350-*.md)
