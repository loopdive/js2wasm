# §27.4 AsyncFunction

**Spec**: https://tc39.es/ecma262/#sec-async-function-constructor
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/AsyncFunction`
**Coverage**: 6 / 18 pass (33.3%) — 12 fail, 0 skip
**Top error buckets**: assertion_fail=8, type_error=3, wasm_compile=1

## What the spec requires

AsyncFunction constructor (callable as function with body string) requires host eval.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts`

## Gap

6/18 (33.3%). new AsyncFunction(...) requires runtime parse+compile — #1324-style pure-Wasm path needed.
