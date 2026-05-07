# §7.1.18 ToObject

**Spec**: https://tc39.es/ecma262/#sec-toobject
**Status**: ⚠️ partial
**Test262 categories**: (none — covered transitively)
**Coverage**: not directly measured

## What the spec requires

ToObject is implicit at member-access sites (string boxing for `.length`, number boxing for `.toFixed`). null/undefined → TypeError is emitted at the call site.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (__to_object)`
- `src/codegen/property-access.ts`

## Gap

TypeError messages do not always include the original expression context (issue #1317).

## Issues filed / referenced

- [#1317](../plan/issues/sprints/50/1317-*.md)
