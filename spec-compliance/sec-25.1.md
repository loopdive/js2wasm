# §25.1 ArrayBuffer Objects

**Spec**: https://tc39.es/ecma262/#sec-arraybuffer-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/ArrayBuffer`
**Coverage**: 87 / 196 pass (44.4%) — 100 fail, 9 skip
**Top error buckets**: wasm_compile=44, assertion_fail=36, other=9

## What the spec requires

ArrayBuffer is implemented as a Wasm-memory chunk indexed by a struct {byteLength, ptr, detached}. ArrayBuffer.transfer / transferToFixedLength / resize / detached are partially supported.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts`
- `src/codegen/registry`

## Gap

87/196 (44.4%). 44 wasm_compile errors — TypedArray constructor + ArrayBuffer interaction. Resizable buffers (#growable proposal) partial.

## Issues filed / referenced

- [#1350](../plan/issues/sprints/50/1350-*.md)
