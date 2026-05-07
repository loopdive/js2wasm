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
