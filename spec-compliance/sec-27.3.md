# §27.3 GeneratorFunction

**Spec**: https://tc39.es/ecma262/#sec-generatorfunction-constructor
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/GeneratorFunction`, `built-ins/GeneratorPrototype`
**Coverage**: 15 / 84 pass (17.9%) — 69 fail, 0 skip
**Top error buckets**: type_error=25, assertion_fail=15, unreachable=14

## What the spec requires

GeneratorFunction constructor (callable as function) is supported. GeneratorPrototype.{next/return/throw} work.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts`

## Gap

GeneratorFunction 6/23 (26%), GeneratorPrototype 9/61 (14.8%). High type_error count — invalid-receiver checks missing.

## Issues filed / referenced

- [#1345](../plan/issues/sprints/50/1345-*.md)
