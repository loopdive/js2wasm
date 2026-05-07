# §28.3 ShadowRealm Objects

**Spec**: https://tc39.es/ecma262/#sec-shadowrealm-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/ShadowRealm`
**Coverage**: 3 / 64 pass (4.7%) — 61 fail, 0 skip
**Top error buckets**: type_error=58, wasm_compile=3

## What the spec requires

ShadowRealm requires a per-realm parser+compiler — not feasible in standalone Wasm.

## Current implementation

Files / runtime imports involved:

- `(none)`

## Gap

3/64 (4.7%). 58 type_error — constructor exists but most operations throw.

## Issues filed / referenced

- [#1356](../plan/issues/sprints/50/1356-*.md)
