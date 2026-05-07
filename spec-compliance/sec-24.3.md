# §24.3 WeakMap Objects

**Spec**: https://tc39.es/ecma262/#sec-weakmap-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/WeakMap`
**Coverage**: 110 / 141 pass (78.0%) — 31 fail, 0 skip
**Top error buckets**: assertion_fail=14, runtime_error=9, wasm_compile=3

## What the spec requires

WeakMap is host-only — Wasm GC doesn't expose enough for a pure-Wasm WeakMap.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (WeakMap host fallback)`

## Gap

110/141 (78.0%). 9 runtime_error — likely registration on non-object key.
