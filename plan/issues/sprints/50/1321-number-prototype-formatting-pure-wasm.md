---
id: 1321
sprint: 50
title: "Number.prototype formatting methods (toString/toFixed/toPrecision/toExponential) rely on JS host unnecessarily"
status: ready
created: 2026-05-07
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen, runtime
language_feature: number-formatting
goal: standalone-mode
---
# #1321 — Number.prototype formatting: eliminate JS host dependency

## Problem

`Number.prototype.toString()`, `.toFixed()`, `.toPrecision()`, and `.toExponential()` are
currently implemented as JS host imports in `src/runtime.ts`. This blocks standalone/WASI
mode for any program that formats numbers. These are pure arithmetic + string-building
operations — no JS runtime semantics needed.

Current path: Wasm → `__host_number_toString` / `__host_toFixed` etc. → JS host.

## Why it matters

- Standalone (`--target wasi`) programs that print numbers fail silently or omit formatting
- Goes against the dual-mode principle: every feature should have a Wasm-native path
- Blocks full standalone output for numeric programs (most real programs)

## Spec

- `Number.prototype.toString(radix?)` — §21.1.3.6: radix 2–36, default 10. Integers:
  standard base-N encoding. Floats: shortest round-trip representation (Grisu/Ryu or
  equivalent), then base-N. Edge cases: `-0` → `"0"`, `Infinity` → `"Infinity"`,
  `NaN` → `"NaN"`.
- `Number.prototype.toFixed(fractionDigits)` — §21.1.3.3: fixed-point with `fractionDigits`
  decimal places (0–100). Uses "round half away from zero". Edge cases: very large values
  fall back to exponential.
- `Number.prototype.toPrecision(precision?)` — §21.1.3.5: `precision` significant digits
  (1–100). If no arg, same as `toString()`.
- `Number.prototype.toExponential(fractionDigits?)` — §21.1.3.2: exponential notation.

## Fix approach

Implement each method as a Wasm function in the IR's builtin emission path:

1. Add `emitNumberFormatMethods()` in `src/codegen/index.ts` (or `src/ir/lower.ts`)
   that emits Wasm functions for `__number_toString`, `__number_toFixed`,
   `__number_toPrecision`, `__number_toExponential`.
2. Each function takes `(f64, ...args) → i16-array` (native string) or `externref`
   (JS-string mode).
3. In `src/ir/select.ts` / `src/ir/lower.ts`, route `CallExpression` on
   `Number.prototype.{toString,toFixed,toPrecision,toExponential}` to these Wasm
   implementations instead of host imports.
4. Remove the host-import wiring in `src/runtime.ts` for these methods (keep as fallback
   for JS-host mode only if needed).

For the float→string conversion kernel, a simple but correct Grisu2-lite or Dragon4
implementation in Wasm suffices. The test262 suite covers all edge cases.

## Acceptance criteria

1. `(3.14159).toFixed(2)` → `"3.14"` in standalone mode (no JS host)
2. `(255).toString(16)` → `"ff"` in standalone mode
3. `(0.000123).toExponential(2)` → `"1.23e-7"` in standalone mode
4. `NaN.toString()` → `"NaN"`, `Infinity.toFixed(2)` → `"Infinity"`
5. Test262: `test/built-ins/Number/prototype/toString/`,
   `test/built-ins/Number/prototype/toFixed/`,
   `test/built-ins/Number/prototype/toPrecision/`,
   `test/built-ins/Number/prototype/toExponential/` — no regressions

## Files

- `src/codegen/index.ts` or `src/ir/lower.ts` — new Wasm implementations
- `src/ir/select.ts` — route method calls to Wasm path
- `src/runtime.ts` — remove or gate host imports
- `tests/issue-1321.test.ts` — equivalence tests
