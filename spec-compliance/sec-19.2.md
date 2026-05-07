# §19.2 Function Properties (parseInt, parseFloat, isNaN, isFinite, encode/decodeURI*)

**Spec**: https://tc39.es/ecma262/#sec-function-properties-of-the-global-object
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/parseInt`, `built-ins/parseFloat`, `built-ins/isNaN`, `built-ins/isFinite`, `built-ins/eval`, `built-ins/encodeURI`, `built-ins/decodeURI`, `built-ins/encodeURIComponent`, `built-ins/decodeURIComponent`
**Coverage**: 246 / 322 pass (76.4%) — 76 fail, 0 skip
**Top error buckets**: other=43, assertion_fail=18, runtime_error=6

## What the spec requires

All 9 global functions are imported from the host. parseInt has an externref + f64-NaN-sentinel signature for the optional radix.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts`

## Gap

isNaN 7/15, isFinite 8/15 — assertion_fail on ToNumber-coerced-then-checked tests. encodeURI / decodeURI* show 'other' errors (likely UTF-16 surrogate handling).
