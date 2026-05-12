# §22.2 RegExp Objects

**Spec**: https://tc39.es/ecma262/#sec-regexp-regular-expression-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/RegExp`, `built-ins/RegExpStringIteratorPrototype`
**Coverage**: 1494 / 1896 pass (78.8%) — 402 fail, 0 skip
**Top error buckets**: null_deref=152, assertion_fail=127, type_error=73

## What the spec requires

RegExp is host-only. The four Symbol-protocol bridges (@@match, @@replace, @@search, @@split) are mostly working but have spec-compliance gaps.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (RegExp host fallback)`

## Gap

1494/1879 (79.5%). 136 null_deref, 127 assertion_fail. Follow-up work covers all Symbol-protocol and edge-case work.
