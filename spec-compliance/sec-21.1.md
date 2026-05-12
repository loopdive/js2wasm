# §21.1 Number Objects

**Spec**: https://tc39.es/ecma262/#sec-number-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Number`
**Coverage**: 292 / 338 pass (86.4%) — 44 fail, 2 skip
**Top error buckets**: assertion_fail=32, range_error=6, wasm_compile=2

## What the spec requires

Number constructor, Number.prototype.{toFixed, toExponential, toPrecision, toString, valueOf}, Number.isInteger, Number.isSafeInteger, Number.MAX_SAFE_INTEGER, etc.

## Current implementation

Files / runtime imports involved:

- `src/codegen/literals.ts`
- `src/runtime.ts (Number.prototype)`

## Gap

292/338 (86.4%). 6 RangeError fails on toFixed extreme-digits. Number.prototype formatting in standalone mode is incomplete.
