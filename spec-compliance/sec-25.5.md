# §25.5 JSON Object

**Spec**: https://tc39.es/ecma262/#sec-json-object
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/JSON`
**Coverage**: 87 / 165 pass (52.7%) — 78 fail, 0 skip
**Top error buckets**: assertion_fail=68, other=3, runtime_error=3

## What the spec requires

JSON.parse and JSON.stringify currently delegate to host JSON.* (issue #1324 plans pure-Wasm).

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (host JSON.parse/stringify)`

## Gap

JSON.parse 71%, JSON.stringify 26%. JSON.stringify replacer-callback / toJSON method / property-list / circular-detection: most failures here. Pure-Wasm impl pending #1324.

## Issues filed / referenced

- [#1324](../plan/issues/sprints/50/1324-*.md)
- [#1341](../plan/issues/sprints/50/1341-*.md)
