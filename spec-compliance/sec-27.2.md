# §27.2 Promise Objects

**Spec**: https://tc39.es/ecma262/#sec-promise-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Promise`
**Coverage**: 466 / 652 pass (71.5%) — 171 fail, 15 skip
**Top error buckets**: other=80, promise_error=38, assertion_fail=29

## What the spec requires

Promise constructor, Promise.{resolve, reject, all, allSettled, any, race, withResolvers, try}, Promise.prototype.{then, catch, finally} are implemented through host.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts`
- `src/codegen/expressions.ts (await)`

## Gap

466/652 (71.5%). 80 'other' + 38 promise_error + 29 assertion_fail. Microtask scheduling: #1326. Async closure leaks: #1311, #1312.

## Issues filed / referenced

- [#1311](../plan/issues/sprints/50/1311-*.md)
- [#1312](../plan/issues/sprints/50/1312-*.md)
- [#1326](../plan/issues/sprints/50/1326-*.md)
