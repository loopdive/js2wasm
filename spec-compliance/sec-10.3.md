# §10.3 Built-in Function Objects

**Spec**: https://tc39.es/ecma262/#sec-built-in-function-objects
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

Built-in functions are pre-imported from the host (fast path) or compiled to dedicated Wasm functions. The registry in src/codegen/registry maps method names to Wasm emitters.

## Current implementation

Files / runtime imports involved:

- `src/codegen/registry`
