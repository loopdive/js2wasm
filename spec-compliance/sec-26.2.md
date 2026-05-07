# §26.2 FinalizationRegistry Objects

**Spec**: https://tc39.es/ecma262/#sec-finalization-registry-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/FinalizationRegistry`
**Coverage**: 18 / 47 pass (38.3%) — 4 fail, 25 skip
**Top error buckets**: assertion_fail=3, type_error=1

## What the spec requires

FinalizationRegistry host-only. 18/47 (38.3%, 25 skipped — no observable GC in test runner).

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (host)`
