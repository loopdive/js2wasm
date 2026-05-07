# §28.2 The Proxy Object

**Spec**: https://tc39.es/ecma262/#sec-proxy-objects
**Status**: ❌ not implemented
**Test262 categories**: `built-ins/Proxy`
**Coverage**: 67 / 311 pass (21.5%) — 235 fail, 9 skip
**Top error buckets**: assertion_fail=146, type_error=53, null_deref=22

## What the spec requires

Proxy host-only — see §10.5. 67/311 (21.5%).

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (host)`
