---
id: 175
title: "Bug: Negative zero not preserved in arithmetic operations"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: compilable
---
# #175 — Bug: Negative zero not preserved in arithmetic operations

## Status: review

## Summary
Arithmetic operations that should produce negative zero (-0) instead produce positive zero (+0). This affects modulus, subtraction, and multiplication edge cases.

## Motivation
5 test262 failures:
- `modulus/S11.5.3_A4_T2.js` — `-1 % -1` should be `-0` but is `+0`
- `modulus/S11.5.3_A4_T5.js`, `S11.5.3_A4_T6.js` — similar negative zero modulus cases
- `subtraction/S11.6.2_A3_T1.5.js` — object subtraction should produce NaN
- `multiplication/S11.5.1_A3_T1.5.js` — object multiplication should produce NaN

The modulus cases test `1 / (x % y)` to distinguish `+0` from `-0` (yields `+Infinity` vs `-Infinity`). Wasm's `f64.copysign` could be used to preserve the sign.

## Scope
- `src/codegen/expressions.ts` — arithmetic operators for modulus sign handling
- The subtraction/multiplication failures are really about object-to-number coercion (see #139)

## Complexity
S

## Acceptance criteria
- [ ] `-1 % -1` produces `-0` (not `+0`)
- [ ] `(-1) % 1` produces `-0`
- [ ] 3 modulus test262 failures fixed

## Implementation notes
- Added `f64.copysign` after modulo computation to preserve dividend sign on zero results
- JS spec: remainder sign follows dividend, so `copysign(result, a)` is correct for all cases
- Handles -1 % -1 = -0, (-1) % 1 = -0, etc.
