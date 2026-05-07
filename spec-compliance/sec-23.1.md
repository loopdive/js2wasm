# §23.1 Array Objects

**Spec**: https://tc39.es/ecma262/#sec-array-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Array`, `built-ins/ArrayIteratorPrototype`
**Coverage**: 1429 / 3108 pass (46.0%) — 1660 fail, 19 skip
**Top error buckets**: assertion_fail=1062, wasm_compile=222, other=149

## What the spec requires

Array exotic objects use a struct {length: i32, elements: (mut ref array)}. Typed-element arrays use specialized Wasm i32/f64 arrays for performance. All 35+ Array.prototype methods are inlined.

## Current implementation

Files / runtime imports involved:

- `src/codegen/array-methods.ts`
- `src/codegen/array-element-typing.ts`

## Gap

1412/3081 (45.8%). 222 wasm_compile errors — type-mixing in callbacks (heterogeneous arrays). 1052 assertion_fail — sparse-array semantics, custom-class constructors (Symbol.species), Array.from with iterable hosts. Array.from externref iterator bridge: #1320.

## Issues filed / referenced

- [#1320](../plan/issues/sprints/50/1320-*.md)
- [#1339](../plan/issues/sprints/50/1339-*.md)
