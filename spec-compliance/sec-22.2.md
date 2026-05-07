# §22.2 RegExp Objects

**Spec**: https://tc39.es/ecma262/#sec-regexp-regular-expression-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/RegExp`, `built-ins/RegExpStringIteratorPrototype`
**Coverage**: 1494 / 1896 pass (78.8%) — 402 fail, 0 skip
**Top error buckets**: null_deref=152, assertion_fail=127, type_error=73

## What the spec requires

RegExp is host-only (issue #1002 closed as scoping). The four Symbol-protocol bridges (@@match, @@replace, @@search, @@split) are mostly working but have spec-compliance gaps.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (RegExp host fallback)`

## Gap

1494/1879 (79.5%). 136 null_deref, 127 assertion_fail. Sub-issues: #1328-1333 cover all Symbol-protocol and edge-case work.

## Issues filed / referenced

- [#1002](../plan/issues/sprints/50/1002-*.md)
- [#1328](../plan/issues/sprints/50/1328-*.md)
- [#1329](../plan/issues/sprints/50/1329-*.md)
- [#1330](../plan/issues/sprints/50/1330-*.md)
- [#1331](../plan/issues/sprints/50/1331-*.md)
- [#1332](../plan/issues/sprints/50/1332-*.md)
- [#1333](../plan/issues/sprints/50/1333-*.md)
