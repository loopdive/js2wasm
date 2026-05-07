# §27.5 AsyncGeneratorFunction

**Spec**: https://tc39.es/ecma262/#sec-async-generator-function-constructor
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/AsyncGeneratorFunction`, `built-ins/AsyncGeneratorPrototype`
**Coverage**: 32 / 71 pass (45.1%) — 39 fail, 0 skip
**Top error buckets**: type_error=22, assertion_fail=8, wasm_compile=3

## What the spec requires

Implementation of AsyncGenerator state-machine handles next/return/throw via Promise resolvers.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts`

## Gap

AsyncGeneratorPrototype 26/48 (54%); AsyncIteratorPrototype 1/13 (7.7%) — receiver TypeErrors.

## Issues filed / referenced

- [#1345](../plan/issues/sprints/50/1345-*.md)
