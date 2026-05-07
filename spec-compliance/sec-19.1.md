# §19.1 Value Properties of the Global Object (Infinity, NaN, undefined)

**Spec**: https://tc39.es/ecma262/#sec-value-properties-of-the-global-object
**Status**: ✅ conforming
**Test262 categories**: `built-ins/Infinity`, `built-ins/NaN`, `built-ins/undefined`
**Coverage**: 19 / 20 pass (95.0%) — 1 fail, 0 skip
**Top error buckets**: assertion_fail=1

## What the spec requires

Infinity, NaN, undefined inline to f64/externref constants. 19/20 pass.

## Current implementation

Files / runtime imports involved:

- `src/codegen/literals.ts`
