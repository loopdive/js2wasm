# §21.3 The Math Object

**Spec**: https://tc39.es/ecma262/#sec-math-object
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Math`
**Coverage**: 309 / 327 pass (94.5%) — 18 fail, 0 skip
**Top error buckets**: assertion_fail=9, wasm_compile=5, type_error=1

## What the spec requires

Math.{abs, sign, floor, ceil, round, trunc, fround, sqrt, cbrt, hypot, max, min, pow, exp, log/log2/log10/log1p, sin/cos/tan, asin/acos/atan/atan2, sinh/cosh/tanh, asinh/acosh/atanh, expm1, clz32, imul, random} all implemented. fround uses f64.promote_f32.

## Current implementation

Files / runtime imports involved:

- `src/codegen/math-helpers.ts`
- `src/runtime.ts (Math.* host imports)`

## Gap

309/327 (94.5%). Math.random uses host import (issue #1322 plans wasi_random_get). 9 assertion_fail on edge cases (sign of -0, hypot 0/Inf, etc.).
