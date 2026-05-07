# §25.4 Atomics

**Spec**: https://tc39.es/ecma262/#sec-atomics
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Atomics`
**Coverage**: 92 / 382 pass (24.1%) — 48 fail, 242 skip
**Top error buckets**: other=21, wasm_compile=12, type_error=9

## What the spec requires

Atomics requires SharedArrayBuffer; most tests are skipped. The stubbed methods (load, store, add, compareExchange, exchange) match spec on plain ArrayBuffer but no actual concurrency.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (no-op stubs)`

## Gap

92/382 (24.1%) with 242 skip. Practical limit: requires shared-memory Wasm threads.
