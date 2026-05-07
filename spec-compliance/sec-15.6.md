# §15.6 Async Generator Function Definitions

**Spec**: https://tc39.es/ecma262/#sec-async-generator-function-definitions
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/AsyncGeneratorFunction`, `built-ins/AsyncGeneratorPrototype`, `language/statements/async-generator`, `language/expressions/async-generator`
**Coverage**: 665 / 995 pass (66.8%) — 324 fail, 6 skip
**Top error buckets**: assertion_fail=233, runtime_error=36, type_error=24

## What the spec requires

Async generators combine the generator state-machine with await suspension. AsyncGeneratorRequestQueue is implemented as a linked-list of Promise resolvers.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts`

## Gap

AsyncGeneratorPrototype 54.2% — type_error on misuse of .next/.return/.throw before/after completion.
