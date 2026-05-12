# §15.4 Generator Function Definitions

**Spec**: https://tc39.es/ecma262/#sec-generator-function-definitions
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/GeneratorFunction`, `built-ins/GeneratorPrototype`, `language/expressions/generators`, `language/statements/generators`
**Coverage**: 341 / 640 pass (53.3%) — 295 fail, 4 skip
**Top error buckets**: assertion_fail=184, type_error=40, runtime_error=26

## What the spec requires

Generator functions are compiled to a state-machine struct + a step function. yield/yield\* re-enter via a tagged union of suspension points.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts (yield/yield*)`

## Gap

GeneratorPrototype 14.8% — many type_error and unreachable failures suggest the.return()/.throw() paths are incomplete. yield in nested try/finally has bugs.
