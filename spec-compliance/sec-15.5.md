# §15.5 Async Function Definitions

**Spec**: https://tc39.es/ecma262/#sec-async-function-definitions
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/AsyncFunction`, `language/statements/async-function`, `language/expressions/async-function`, `language/expressions/async-arrow-function`
**Coverage**: 180 / 245 pass (73.5%) — 57 fail, 8 skip
**Top error buckets**: runtime_error=25, assertion_fail=22, type_error=4

## What the spec requires

Async functions are compiled to functions returning a Promise. await is lowered to a continuation suspension via a state-machine, similar to generators. PromiseResolve/Reject host imports drive the resumption.

## Current implementation

Files / runtime imports involved:

- `src/codegen/expressions.ts (await)`
- `src/runtime.ts`

## Gap

Async recursive closure leaks unhandled rejection (issue #1312). await of non-Promise should pass-through; currently doesn't always unwrap thenables (#1313).

## Issues filed / referenced

- [#1312](../plan/issues/sprints/50/1312-*.md)
- [#1313](../plan/issues/sprints/50/1313-*.md)
