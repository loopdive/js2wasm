# wasm-opt coverage notes

A running record of optimisations the Binaryen `wasm-opt` pass already
performs (and so should NOT be duplicated in our own codegen passes),
plus optimisations it does NOT perform that we may need to handle
ourselves. Updated when a perf issue prompts measurement.

## Loop-invariant code motion (LICM) — `struct.get` for `arr.length`

**Issue**: #1200.

**Question**: For the canonical `for (let i = 0; i < arr.length; i++) ...`
pattern, does `wasm-opt -O3` hoist the `arr.length` read (lowered as
`struct.get $vec 0 (local.get $arr)`) out of the loop condition?

**Answer**: **No, wasm-opt does NOT statically hoist** the length read.
But **V8's JIT effectively does at runtime**, so the static count
overstates the runtime cost.

### Static measurement (2026-05-03)

Source:
```ts
export function arraySum(arr: number[]): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!;
  return sum;
}
```

Both baseline (no `--optimize`) and optimized (`--optimize`, default
level `-O3`) emit:

```wat
(loop $label
  (br_if $block
    (i32.eqz
      (i32.lt_s
        (local.get $2)
        (struct.get $1 0 (local.get $0)))))   ;; <-- INSIDE the loop
  ...
  ;; body uses (struct.get $1 1 (local.get $0)) for vec.data
  ...
  (br $label))
```

`struct.get $1 0` (vec.length) is statically inside the loop in both
binaries. wasm-opt's LICM declined to hoist it — most likely because
`struct.get` on a nullable ref can trap, and hoisting a potentially-
trapping op out of a loop that might iterate zero times changes
"never trap" to "always trap" at the call site.

### Runtime measurement (V8, microbenchmark)

`tsx` benchmark: 1M-element array sum, 20 iterations, median time:

| variant | unopt median | opt (-O3) median |
|---------|--------------|------------------|
| re-eval `arr.length` each iter | 6.51 ms | 6.70 ms |
| manually hoisted `const len = arr.length` | 6.60 ms | 6.65 ms |

The difference is within timing noise (≤1%). V8's JIT pulls the
struct.get out of the loop body at compile time, so the source-level
"redundant" read costs nothing at steady state.

### Decision

**Do not implement codegen-side LICM for this pattern.** V8's JIT
already optimises it to identical hot code; adding a Binaryen-pass
or codegen-side hoisting step would:

1. Add complexity (mutation analysis to prove `arr` isn't reassigned in
   the body).
2. Produce a slightly larger pre-V8 binary (extra local + `local.set`).
3. Yield zero measurable wall-clock improvement.

The smaller-and-equivalent baseline is preferable. Re-revisit if a
non-V8 runtime (Wasmtime, Wasmer, hand-rolled interpreter) shows a
meaningful gap on the same shape.

## Other notes

(Add new findings as they accrue.)
