# §19 The Global Object

**Spec**: https://tc39.es/ecma262/#sec-global-object
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/global`
**Coverage**: 19 / 29 pass (65.5%) — 10 fail, 0 skip
**Top error buckets**: assertion_fail=4, range_error=4, other=2

## What the spec requires

globalThis maps to a host externref in JS-host mode and a synthesized empty object in standalone mode.

## Current implementation

Files / runtime imports involved:

- `src/codegen/index.ts (globalThis)`
- `src/runtime.ts`

## Gap

65.5% pass — assertion failures on globalThis.eval and frozen-globalThis tests.
