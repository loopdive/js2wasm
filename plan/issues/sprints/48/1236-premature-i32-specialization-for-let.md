---
id: 1236
sprint: 48
title: "Premature i32 specialization for `let s = 0` accumulators silently saturates on overflow"
status: done
created: 2026-05-01
updated: 2026-05-03
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

## Resolution

Fixed in commit `8122930b6` (PR #151) — `fix(#1236): let s=0 accumulators
no longer saturate at i32.MAX`. The fix lives in
`src/codegen/function-body.ts`: the `isI32SafeExpr` and
`isCompoundI32Safe` helpers no longer treat `+`, `-`, `*` on i32-shaped
operands as i32-safe (the previous comment "overflow wrap is OK" was
incorrect — codegen routes those through f64, then the trailing
`i32.trunc_sat_f64_s` SATURATES at i32.MAX). After the fix, accumulators
that take arithmetic writes are widened to f64 in the candidate-promotion
pass, and the trunc_sat round-trip disappears.

The IR Stage 2 inference rules from #1126 (commit `2002f5271`) further
reinforce this at the IR level by narrowing to i32 only when every
producer is a proven i32 (`i32.add`, `i32.and`, `| 0`, etc.) — the
recommended Option (B) route from the implementation plan above.

### Verification

`tests/issue-1236.test.ts` (9 cases, all pass on origin/main):

- **repro from the issue file**:
  - sum 0..1,000,000 returns `499999500000` (matches V8) instead of i32.MAX
  - V8 differential — Wasm and host agree
- **WAT-level proof**: `(local $s f64)` for the accumulator; no
  `f64.add` followed by `i32.trunc_sat_f64_s` in the function body
- **compound assignment safety**: `s += i`, `s -= i`, `s *= 2` all
  preserve f64 semantics (covering all three flagged `+ - *` operators)
- **#595 regression guard**: `for (let i = 0; i < n; i++)` counter
  `(local $i i32)` — bounded loop counters still i32
- **bitwise still i32-safe**: `mask = mask | bit` keeps mask as i32

Manual smoke-tested an additional 7 variations (compound `+=` /
declared-then-assigned / sum-via-helper / multiplicative product) —
all match V8 exactly.

The playground "Loop: 1M Int32 sum" benchmark uses `(s + i) | 0` with
explicit i32 wrap; that path already returns the correct V8-equivalent
wrapped value (`1783293664`). Both the saturation soundness bug AND
the explicit-wrap path are working as expected.
