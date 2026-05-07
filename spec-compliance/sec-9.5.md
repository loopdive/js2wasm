# §9.5 Jobs and Host Operations

**Spec**: https://tc39.es/ecma262/#sec-jobs
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Promise`
**Coverage**: 466 / 652 pass (71.5%) — 171 fail, 15 skip
**Top error buckets**: other=80, promise_error=38, assertion_fail=29

## What the spec requires

Promise jobs (HostEnqueuePromiseJob) are scheduled via host import in JS-host mode. The microtask queue is the host's. AsyncFromSyncIteratorContinuation is implemented.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (__schedule_microtask)`
- `src/codegen/expressions.ts (await)`

## Gap

Pure-Wasm microtask queue is not yet implemented (issue #1326).
