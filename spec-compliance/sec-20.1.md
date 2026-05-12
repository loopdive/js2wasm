# §20.1 Object Objects

**Spec**: https://tc39.es/ecma262/#sec-object-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Object`
**Coverage**: 1858 / 3411 pass (54.5%) — 1551 fail, 2 skip
**Top error buckets**: assertion_fail=1293, other=83, type_error=69

## What the spec requires

Object constructor and all 24 static methods (defineProperty, defineProperties, freeze, fromEntries, getOwnPropertyDescriptor,...) are mapped to Wasm helpers + host imports.

## Current implementation

Files / runtime imports involved:

- `src/codegen/object-ops.ts`
- `src/runtime.ts`

## Gap

Coverage 54.5%. Object.defineProperty is the largest single failure bucket (664 fails) — descriptor-attribute fidelity. Object.assign drops getters.
