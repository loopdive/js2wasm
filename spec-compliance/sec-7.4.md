# §7.4 Operations on Iterator Objects

**Spec**: https://tc39.es/ecma262/#sec-operations-on-iterator-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Iterator`, `built-ins/IteratorPrototype`, `built-ins/AsyncIteratorPrototype`, `built-ins/StringIteratorPrototype`, `built-ins/ArrayIteratorPrototype`, `built-ins/MapIteratorPrototype`, `built-ins/SetIteratorPrototype`
**Coverage**: 201 / 579 pass (34.7%) — 378 fail, 0 skip
**Top error buckets**: assertion_fail=162, wasm_compile=142, null_deref=29

## What the spec requires

GetIterator / IteratorNext / IteratorClose are implemented via host imports for externref iterables; typed Array iteration is inlined to a counted loop.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts (for-of)`
- `src/runtime.ts (__iterator_*)`

## Gap

Pure-Wasm iterator protocol is not yet implemented for standalone mode. Iterator helpers (drop/take/map/filter/flatMap/some/every/find/reduce/toArray) coverage is 30% — many fail with assertion_fail or wasm_compile errors.
