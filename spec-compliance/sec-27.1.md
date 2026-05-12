# §27.1 Iteration

**Spec**: https://tc39.es/ecma262/#sec-iteration
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Iterator`, `built-ins/IteratorPrototype`
**Coverage**: 156 / 510 pass (30.6%) — 354 fail, 0 skip
**Top error buckets**: assertion_fail=146, wasm_compile=142, null_deref=29

## What the spec requires

Iterator helpers (drop, take, map, filter, flatMap, reduce, some, every, find, forEach, toArray) are wired up.

## Current implementation

Files / runtime imports involved:

- `src/codegen/registry (iterator-helpers)`

## Gap

Iterator 156/510 (30.6%). 142 wasm_compile errors — iterator typed-protocol mismatch. Pure-Wasm iterator-protocol: follow-up work. Iterator.from on externref: follow-up work.
