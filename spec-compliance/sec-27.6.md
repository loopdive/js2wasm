# §27.6 DisposableStack / AsyncDisposableStack / SuppressedError (Explicit Resource Management)

**Spec**: https://tc39.es/ecma262/#sec-disposablestack-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/DisposableStack`, `built-ins/AsyncDisposableStack`, `built-ins/SuppressedError`
**Coverage**: 75 / 165 pass (45.5%) — 90 fail, 0 skip
**Top error buckets**: type_error=61, assertion_fail=20, wasm_compile=6

## What the spec requires

using/await using declarations + DisposableStack runtime are partially implemented.

## Current implementation

Files / runtime imports involved:

- `src/codegen/registry`

## Gap

DisposableStack 47/91 (52%), AsyncDisposableStack 22/52 (42%), SuppressedError 6/22 (27%). TypeError on misuse-of-disposed-stack incomplete. await using TDZ tests null.
