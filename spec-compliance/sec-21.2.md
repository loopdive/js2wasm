# §21.2 BigInt Objects

**Spec**: https://tc39.es/ecma262/#sec-bigint-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/BigInt`
**Coverage**: 30 / 77 pass (39.0%) — 47 fail, 0 skip
**Top error buckets**: assertion_fail=24, runtime_error=13, other=5

## What the spec requires

BigInt is supported in JS-host mode via direct externref forwarding. BigInt arithmetic operators delegate to host helpers.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (host fallback)`

## Gap

30/77 (39.0%). 13 runtime errors and 4 illegal_cast — typed paths assume f64 too eagerly. Standalone BigInt (i64 + arbitrary-precision fallback) not implemented.

## Issues filed / referenced

- [#1350](../plan/issues/sprints/50/1350-*.md)
