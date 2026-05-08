---
id: 1322
sprint: 50
title: "Math.random() has no standalone fallback — requires JS host import in WASI/standalone mode"
status: in-progress
created: 2026-05-07
updated: 2026-05-07
priority: low
feasibility: easy
reasoning_effort: low
task_type: feature
area: runtime, codegen
language_feature: math-random
goal: standalone-mode
---
# #1322 — Math.random(): wire to WASI `random_get` in standalone mode

## Problem

`Math.random()` is currently always a JS host import. In standalone/WASI mode it
either crashes (if the import is missing) or returns `0` (if the host provides a stub).

## Fix

In `--target wasi` mode, emit a Wasm function `__math_random` that:
1. Calls WASI `random_get(ptr, 8)` to fill 8 bytes of linear memory with entropy
2. Reads the 8 bytes as `i64`, masks to 53 significant bits
3. Multiplies by `2^-53` to produce a uniform float in `[0, 1)`

This matches the approach used by WASI libc and is spec-compliant (Math.random must
return a float in `[0, 1)` — distribution quality is implementation-defined).

For non-WASI standalone mode (pure Wasm, no WASI), a simple xorshift64 PRNG seeded
from a module-level global is acceptable.

## Acceptance criteria

1. `Math.random()` returns a float in `[0, 1)` in a `--target wasi` compiled binary
   without any JS host
2. Repeated calls return different values (not constant 0)
3. No regression in JS-host mode (where `Math.random` remains a host import)

## Files

- `src/codegen/index.ts` — detect WASI target in Math.random emission, emit WASI call
- WASI import already present: `fd_write` etc. are in `src/codegen/index.ts` around the
  WASI import block; add `random_get` alongside them
- `tests/issue-1322.test.ts` — basic range + non-constant check

## Implementation (dev-a)

Three files touched:
1. `src/codegen/index.ts` — `registerWasiImports`: scan source for
   `Math.random()` calls; if found, register `wasi_snapshot_preview1.random_get`
   import EARLY (before any defined helpers) so the late-import shift bug
   doesn't break `__str_*` indices.
2. `src/codegen/index.ts` + `src/codegen/declarations.ts` — `collectMathImports`
   finalize: in WASI mode, route `random` to `pendingMathMethods` (so
   `emitInlineMathFunctions` emits `Math_random` as a defined function).
   In JS-host mode, keep the `env.Math_random` host import unchanged.
3. `src/codegen/math-helpers.ts` — `emitInlineMathFunctions`: emit
   `Math_random` as a defined function. Calls `random_get(64, 8)`,
   reads back two `i32.load`s (low + high), combines via
   `i64.extend_i32_u + i64.shl + i64.or`, shifts right 11 to mask to
   53 unsigned bits, converts via `f64.convert_i64_s` (the value
   already fits in 53 bits, so `_s` is correct), and multiplies by 2⁻⁵³.

The IR doesn't include `i64.load` or `f64.convert_i64_u`, hence the
two-`i32.load` decomposition and the `_s` convert. Memory offset 64
is used for the entropy buffer — well within the 1024-byte reserved
prefix that `registerWasiImports` already sets up via the bump pointer
initial value.

The xorshift64 fallback for "non-WASI standalone" is deferred — there
is no separate non-WASI standalone target today (`gc`/`linear`/`wasi`
are the three targets, and only `wasi` is JS-host-free). When a
genuine pure-Wasm-no-WASI mode lands, the same `Math_random` function
slot can be filled with the xorshift64 body.

## Test Results

`tests/issue-1322.test.ts` — 6 tests, all pass:

- returns a float in [0, 1) (50 samples)
- repeated calls return distinct values (>15 unique in 20 samples)
- `Math.floor(Math.random() * 6)` covers all 6 dice faces in 600 trials
- WASI binary imports `wasi_snapshot_preview1.random_get` (NOT `env.Math_random`)
- JS-host regression guard: `env.Math_random` remains the host import path
- regression guard: `Math.random` alongside `Math.sin`/`Math.cos` doesn't
  break the shared `pendingMathMethods` collection
