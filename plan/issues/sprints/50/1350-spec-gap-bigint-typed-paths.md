---
id: 1350
sprint: 50
title: "spec gap: BigInt typed-path eager f64 assumptions (47 test262 fails, 4 illegal_cast + 13 runtime)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: bigint
goal: spec-completeness
parent: 1328
---
# #1350 — BigInt: typed paths assume f64 too eagerly

## Problem

`built-ins/BigInt`: **30 / 77 pass (39.0%) — 47 fails (24 assertion_fail, 13 runtime_error,
5 other, 4 illegal_cast, 1 type_error)**.

Spec §21.2 (BigInt): BigInt values are i64 in i64-friendly Wasm or arbitrary-precision otherwise.
Mixing BigInt and Number in arithmetic must throw TypeError; explicit conversion (BigInt(num)) is allowed
for safe-integer-or-toString-parseable inputs.

The `illegal_cast` failures suggest typed paths emit `f64.add` on operands that are externref BigInt,
i.e. our type-coercion is unaware of the BigInt brand. The runtime errors include numeric overflows
(BigInt → toBigInt of a non-finite Number).

## Acceptance criteria

1. `built-ins/BigInt/data-type-mixing-throw-typeerror.js` passes (both operands must be BigInt).
2. `built-ins/BigInt/from-string-numeric-syntax-error.js` passes.
3. `built-ins/BigInt/asIntN-asUintN-bits.js` passes.
4. Pass-rate for `built-ins/BigInt` rises from 39% to ≥75%.

## Files to modify

- `src/codegen/binary-ops.ts` — type-aware operator dispatch
- `src/codegen/type-coercion.ts` — ToBigInt / ToBigNumeric
- `src/runtime.ts` — `__bigint_*` host imports

## Implementation Plan

### Root cause

The type-inference assumes any "numeric" operand is f64 — when an externref BigInt slips through,
`coerceType(externref → f64)` is emitted, which in standalone mode is `f64.const NaN` (illegal_cast
in tests that round-trip).

### Approach

1. Tag BigInt-shaped externref locals with a TypeScript-level brand (so type-inference knows).
2. In `compileBinaryOp`, check if either operand has the BigInt brand → dispatch to `__bigint_X`
   host helper instead of f64 ops.
3. Add `BigInt(value)`, `BigInt.asIntN(bits, value)`, `BigInt.asUintN(bits, value)` wrappers that
   throw on non-integer numbers.

### Edge cases

- `1n + 1` → TypeError per spec.
- `BigInt(1.5)` → RangeError per spec (must be safe integer).
- `BigInt("0xff")` → 255n (parses hex/octal/binary literals).
- `0n` is falsy.

### Test262 sample

- `test262/test/built-ins/BigInt/data-type-mixing-throw-typeerror.js`
- `test262/test/built-ins/BigInt/from-string-numeric-syntax-error.js`
- `test262/test/built-ins/BigInt/asIntN-asUintN-bits.js`
