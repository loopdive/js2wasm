---
id: 1173
title: "js2wasm output uses 'exact' reference types that wasmtime 44 rejects (array-sum benchmark crash)"
status: done
created: 2026-04-27
updated: 2026-04-27
completed: 2026-04-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays
goal: compilable
pr: 57
merged: 2026-04-27
origin: surfaced by `#1125` competitive benchmark verification (2026-04-27)
---
# #1173 — js2wasm emits 'exact' reference types that wasmtime 44 rejects on `--target wasi`

## Problem

The `array-sum` benchmark program (a basic array fill + sum kernel) compiles
successfully in js2wasm but the resulting Wasm fails `wasmtime compile`:

```
Error: failed to compile: wasm[0]::function[0]

Caused by:
    0: WebAssembly translation error
    1: Invalid input WebAssembly code at offset 77: custom descriptors required for exact reference types
```

The js2wasm output is using "exact" reference types — a recent WasmGC
proposal feature that requires the `custom-descriptors` proposal to be
enabled in wasmtime. wasmtime 44.0.0 (latest stable) does not enable
`custom-descriptors` by default and its `-W` config does not yet expose
it as a stable flag, so the emitted Wasm cannot be loaded.

## Reproduction

Source program (from `benchmarks/competitive/programs/array-sum.js`):

```js
/** @param {number} n @returns {number} */
export function run(n) {
  const values = [];
  for (let i = 0; i < n; i++) {
    values[i] = ((i * 17) ^ (i >>> 3)) & 1023;
  }

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum = (sum + values[i]) | 0;
  }
  return sum | 0;
}
```

Compile path (matches what `benchmarks/compare-runtimes.ts` does for the
js2wasm → Wasmtime lane):

```ts
import { compile } from './src/index.ts';
const result = compile(source, {
  fileName: 'array-sum.js',
  allowJs: true,
  target: 'wasi',
  optimize: 4,
});
// result.success is true — js2wasm thinks it's done
// then: wasm-opt --all-features -O4
// then: wasmtime compile -W gc=y,function-references=y,component-model=y,exceptions=y -O opt-level=2
//       -> FAILS with "custom descriptors required for exact reference types"
```

A 30-line standalone repro lives in `.tmp/repro-array-sum.mjs` from the
benchmark verification work (PR #51 / PR #52). The js2wasm-stage compile
succeeds; the failure is in `wasmtime compile`.

## Root cause hypothesis

js2wasm appears to be emitting `(ref exact $T)` somewhere in the array
codegen path. The WasmGC "exact reference types" proposal allows the
producer to assert that a reference is exactly of type `$T` (not a
subtype), which can enable better cast elimination — but it is gated
behind the `custom-descriptors` proposal.

Likely culprits:
- `src/codegen/expressions.ts` — array-literal / `[]` lowering, especially
  the `__vec_*` struct emission
- `src/codegen/type-coercion.ts` — vec → ref widening
- `src/codegen/index.ts` — type-import emission for vec structs

The fix is to either:
1. **Stop emitting `exact`** in the relevant codegen paths (drop the
   `exact` modifier from the type encodings, falling back to plain
   `(ref $T)`). This is the conservative path and matches what the
   wasm-opt → wasmtime 44 chain accepts today.
2. Keep `exact` but conditionally only when an opt-in flag enables the
   `custom-descriptors` proposal, and pass `-W custom-descriptors=y`
   through to `wasmtime compile`. wasmtime 44 doesn't yet expose this
   as a stable `-W` key, so option 1 is the realistic fix until the
   proposal stabilizes.

## Scope of impact

Any program that constructs an array via `[]` and writes to it with
`values[i] = ...` style assignment. The benchmark surfaces this on a
trivially-shaped kernel; real user programs that use plain JS arrays
will hit the same wall. This blocks all js2wasm `--target wasi` builds
that touch array codegen on wasmtime ≥ 44.

## Acceptance criteria

- `array-sum` benchmark program compiles and runs end-to-end through
  `wasmtime compile` + `wasmtime run --invoke "run(2000)"` with the
  default flag set used by `benchmarks/compare-runtimes.ts`.
- The benchmark JSON shows `js2wasm-wasmtime` lane `status: ok` for
  `array-sum` (matching `fib` / `fib-recursive`, which already work).
- A new `tests/issue-1173.test.ts` reproduces the bug on the current
  failing version and passes after the fix.
- No regression on `fib` / `fib-recursive` js2wasm-wasmtime perf
  numbers (they should not depend on this codegen change).

## Key files

- `src/codegen/expressions.ts` — array literal + indexed assignment
- `src/codegen/type-coercion.ts` — vec/ref widening
- `src/codegen/index.ts` — type-import / struct definitions for `__vec_*`
- `benchmarks/competitive/programs/array-sum.js` — the canonical repro

## Root cause

js2wasm itself never emits `(ref exact $T)` directly — there is no `exact`
opcode in `src/emit/binary.ts`. The exact-reference encoding is added by
`wasm-opt` (Binaryen ≥ 124) when it is run with `--all-features`, which
enables the WasmGC custom-descriptors proposal. With that proposal active,
Binaryen rewrites `(ref $T)` → `(ref exact $T)` for any leaf / single-instance
type — both for explicit `(sub final $T)` declarations *and* for plain
`(struct …)` / `(array …)` types that have no declared subtypes. wasmtime 44
does not yet ship `custom-descriptors` as a stable feature, so the optimized
binary is rejected at load time.

`benchmarks/compare-runtimes.ts` exercises this path on every js2wasm program:

  1. `compile(src, { target: "wasi", optimize: 4 })`
  2. `wasm-opt --all-features -O4`   ← injects exact refs
  3. `wasmtime compile -W gc=y,…`    ← rejects them

`fib` / `fib-recursive` happen to work because their compiled output has no
struct/array types whose ref encoding wasm-opt can rewrite. As soon as a
program touches plain JS arrays (`array-sum`), or strings, or class
hierarchies, the rewrite kicks in.

## Fix

Two pieces, one of each kind:

1. **Compiler-side hygiene** — `src/codegen/fixups.ts:markLeafStructsFinal`
   gains a `skipFinal` parameter that is set to `ctx.wasi` at both call sites
   in `src/codegen/index.ts`. For `--target wasi` builds the leaf-final mark
   is no longer applied, so the type section no longer carries `sub_final`
   opcodes. V8 devirtualization (#594) is preserved for `--target gc`
   (browser) builds.

   This alone is **not sufficient** — wasm-opt still rewrites refs to
   struct/array types that have no `sub` clause at all — but it makes the
   raw js2wasm output safe for any wasmtime-style consumer that does not
   re-run wasm-opt.

2. **Benchmark-harness fix** — `benchmarks/compare-runtimes.ts`'s default
   `WASM_OPT_FLAGS` now includes `--disable-custom-descriptors`. That flag
   is a no-op when the proposal isn't enabled (so older Binaryen builds
   keep working), and it tells modern Binaryen to leave refs as plain
   `(ref $T)` even when the rest of `--all-features` is on.

After both pieces, the array-sum benchmark binary loads in wasmtime 44
without the "custom descriptors" error. (The benchmark lane still surfaces
a separate `env::__unbox_number` host-import gap, which is tracked as
prerequisite work outside this issue's scope.)

## Test Results

- `tests/issue-1173.test.ts` — 4/4 pass:
  1. compiles array-sum kernel with `target: "wasi"`
  2. emits **no** `sub final` declarations under `--target wasi`
  3. **still** emits `sub final` for a 2-class hierarchy under `--target gc`
     (V8 devirtualization preserved)
  4. `benchmarks/compare-runtimes.ts` declares
     `--disable-custom-descriptors` in its default `WASM_OPT_FLAGS`

- Manual end-to-end check (`.tmp/repro-1173.mjs`):
  - raw WAT contains 1 `(exact …)` from Binaryen's display inference (no
    explicit `exact` byte in the binary)
  - optimized WAT contains **0** `(exact …)` after
    `wasm-opt --all-features --disable-custom-descriptors -O4`
  - `wasmtime run` no longer fails with "custom descriptors required";
    the next-layer error is the unrelated `env::__unbox_number` import gap
