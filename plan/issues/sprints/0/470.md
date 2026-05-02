---
id: 470
title: "Fix f64/i32-to-externref type coercion in arithmetic expressions"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: critical
goal: compilable
---
# #470 -- Fix f64/i32-to-externref type coercion in arithmetic expressions

All 13 remaining compile errors and 17 remaining runtime failures in test262 stem from
incorrect type coercion when arithmetic results (f64/i32) are passed to functions
expecting externref.

## Symptoms

**Compile errors (13):**
- `call[0] expected type externref, found f64.add of type f64` (9 tests)
- `call[0] expected type externref, found f64.const of type f64` (1 test)
- `call[0] expected type externref, found i32.const of type i32` (1 test)
- `expected 0 elements on the stack for fallthru, found 2` (2 bigint tests)
- `f64.add[0] expected type f64, found local.tee of type (ref null 8)` (1 closure test)

**Runtime failures (17):**
- All return 0 instead of expected value, concentrated in addition/subtraction/Math.min/max/atanh/expm1

## Affected tests
- `language/expressions/addition/S11.6.1_A*` (multiple)
- `language/expressions/subtraction/S11.6.2_A*` (multiple)
- `built-ins/Math/min/Math.min_each-element-coerced.js`
- `built-ins/Math/max/Math.max_each-element-coerced.js`
- `built-ins/Math/atanh/atanh-specialVals.js`
- `built-ins/Math/expm1/expm1-specialVals.js`

## Root cause
The codegen emits raw f64/i32 values when the target parameter type is externref.
Need to apply `__box_number` import (for f64) or `f64.convert_i32_s` + `__box_number`
(for i32) in the coercion path.

## Approach
- Check `coerceType` in `expressions.ts` for missing f64->externref and i32->externref paths
- Ensure arithmetic expression results are boxed before passing to externref-typed parameters
- Fix bigint-and-number stack balance issue (2 CE)
- Fix closure local.tee type mismatch in Math.hypot test
