# §10.2 ECMAScript Function Objects

**Spec**: https://tc39.es/ecma262/#sec-ecmascript-function-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Function`
**Coverage**: 207 / 509 pass (40.7%) — 301 fail, 1 skip
**Top error buckets**: assertion_fail=122, type_error=65, runtime_error=43

## What the spec requires

Function objects carry [[Environment]] (closure capture struct) and [[FormalParameters]] (via Wasm function-type signature). [[Call]] and [[Construct]] dispatch through the function-table. .length is computed from formal parameter count.

## Current implementation

Files / runtime imports involved:

- `src/codegen/index.ts (function compilation)`
- `src/codegen/closures.ts`

## Gap

Function objects from Wasm are not always JS-callable (issue #1308). .name, .toString(), Function.prototype.bind partial application are partial. Function/internals: 1/8 pass.

## Issues filed / referenced

- [#1308](../plan/issues/sprints/50/1308-*.md)
- [#1337](../plan/issues/sprints/50/1337-*.md)
