# §24.1 Map Objects

**Spec**: https://tc39.es/ecma262/#sec-map-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Map`, `built-ins/MapIteratorPrototype`
**Coverage**: 177 / 215 pass (82.3%) — 38 fail, 0 skip
**Top error buckets**: assertion_fail=26, wasm_compile=6, other=2

## What the spec requires

Map and Map.prototype.{get, set, has, delete, clear, forEach, keys, values, entries, size, [Symbol.iterator]} are implemented via host-imported externref Map. Custom hash/equals via SameValueZero.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (Map host fallback)`
- `src/codegen/registry`

## Gap

166/204 (81.4%). Map.prototype.upsert not implemented. forEach callback closure capture: assertion_fail on `this`-binding.
