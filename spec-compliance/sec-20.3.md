# §20.3 Boolean Objects

**Spec**: https://tc39.es/ecma262/#sec-boolean-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Boolean`
**Coverage**: 27 / 51 pass (52.9%) — 24 fail, 0 skip
**Top error buckets**: assertion_fail=23, type_error=1

## What the spec requires

Boolean wrapper boxing, Boolean.prototype.toString/valueOf are implemented.

## Current implementation

Files / runtime imports involved:

- `src/codegen/object-ops.ts`

## Gap

27/51 (52.9%) — assertion failures on Boolean wrapper coercion (Boolean.prototype.toString.call(0) etc.).

## Issues filed / referenced

- [#1343](../plan/issues/sprints/50/1343-*.md)
