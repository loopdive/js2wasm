# §20.2 Function Objects

**Spec**: https://tc39.es/ecma262/#sec-function-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Function`
**Coverage**: 207 / 509 pass (40.7%) — 301 fail, 1 skip
**Top error buckets**: assertion_fail=122, type_error=65, runtime_error=43

## What the spec requires

Function constructor is partial (string parsing). Function.prototype.call/apply/bind are inlined fast paths.

## Current implementation

Files / runtime imports involved:

- `src/codegen/index.ts`
- `src/codegen/closures.ts`

## Gap

40.7% pass — bind partial application fails when bound length doesn't match. Function.prototype.toString returns an opaque marker, not the original source. new Function() compiles via host eval bridge — not standalone.

## Issues filed / referenced

- [#1338](../plan/issues/sprints/50/1338-*.md)
- [#1308](../plan/issues/sprints/50/1308-*.md)
