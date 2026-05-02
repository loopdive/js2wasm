---
id: 1236
title: "Premature i32 specialization for `let s = 0` accumulators silently saturates on overflow"
status: ready
created: 2026-05-01
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-inference
goal: core-semantics
related: [595, 1166]
es_edition: n/a
origin: "surfaced 2026-05-01 while preparing the playground for an external compiler-engineer review. The 'Loop: sum 1..1M' benchmark returned 2147483647 instead of 499999500000."
---
# #1236 — Premature i32 specialization for `let s = 0` accumulators silently saturates

## Problem

The compiler infers `let s = 0` as `i32` based on the integer-literal initializer
(see #595's `detectI32LoopVar` and similar shape inference for plain `let`).
When the body then performs `s = s + i` with both operands i32-typed, the
compiler routes the `+` through f64 (correct JS semantics: `number + number`
is f64) and stores the result back via `i32.trunc_sat_f64_s`.

The trunc_sat **saturates** rather than wrapping or upgrading the local to
f64. Once the running value exceeds 2³¹−1 the accumulator is pinned at
`2147483647` forever and every subsequent iteration is a no-op against the
saturation ceiling.

This is a soundness bug, not just a perf issue: the program returns the wrong
value with no diagnostic.

## Repro

```ts
export function bench_loop(): number {
  let s = 0;
  for (let i = 0; i < 1000000; i++) s = s + i;
  return s;
}
```

Expected: `499999500000` (matches Node/V8).
Actual:   `2147483647` (saturated i32.MAX).

WAT (current):

```wat
(func $bench_loop (result f64)
  (local $s i32)
  (local $i i32)
  ...
  (loop
    local.get 0
    f64.convert_i32_s
    local.get 1
    f64.convert_i32_s
    f64.add
    i32.trunc_sat_f64_s   ;; silent saturation
    local.set 0
    ...
  ))
```

## Why this happens

- `#595` taught the compiler to allocate i32 locals for loop counters that
  match a narrow pattern.
- The accumulator path goes through the same i32-local allocation because
  `let s = 0` looks integer-shaped at declaration time.
- The codegen for `s = (f64 expression)` falls back to `i32.trunc_sat_f64_s`,
  which is the wrong coercion when the produced value can exceed i32 range.

## Acceptance criteria

1. The repro above returns `499999500000` (matches V8 exactly) in default mode.
2. The fix must not regress #595 — bounded loop counters should stay i32.
3. Add a differential-test that sums `0..1_000_000` and asserts the V8 result.
4. Add a focused unit test compiling the repro and asserting f64 local or
   overflow-safe i32.
5. test262 net delta must be ≥ 0.

## Implementation routes

**A. Conservative widening (simpler):** When shape inference assigns a local to
i32 from an integer-literal init but the only writes come from arithmetic that
produces f64, demote the local to f64. The trunc_sat disappears.

**B. Sound i32 narrowing (preserves #595 perf):** Keep the local i32 only when
every assignment is provably i32 (`i32.add`, `i32.and`, `| 0`, `& mask` etc.).
For mixed-mode RHS, fall back to (A).

Option (A) is simpler and recommended as first pass. Option (B) can follow as
a targeted optimization if #595 regressions appear.

## Related

- #595 — original i32 loop counter inference (this is the soundness gap).
- #1166 — closed-world integer specialization (different scope).
- #1197 — i32 element specialization for `number[]` arrays under `| 0` / `& mask`.
