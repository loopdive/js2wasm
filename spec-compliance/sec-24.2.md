# §24.2 Set Objects

**Spec**: https://tc39.es/ecma262/#sec-set-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Set`, `built-ins/SetIteratorPrototype`
**Coverage**: 293 / 394 pass (74.4%) — 101 fail, 0 skip
**Top error buckets**: assertion_fail=46, other=39, wasm_compile=7

## What the spec requires

Set and Set.prototype methods. New (Stage 4) Set methods: union, intersection, difference, symmetricDifference, isSubsetOf, isSupersetOf, isDisjointFrom are partially implemented.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (Set host fallback)`
- `src/codegen/registry`

## Gap

282/383 (73.6%). 39 'other' errors and 46 assertion_fail — likely the new Set methods on non-Set 'set-like' arguments (must accept any object with.has/.size/.keys).
