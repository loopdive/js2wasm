# Sprint 33 — Benchmark Regression Recovery

**Date**: 2026-04-02
**Goal**: Recover benchmark credibility after codegen regressions were discovered in the playground benchmark suite

## Context

While validating the public benchmark suite for STF/demo use, two concrete performance regressions were identified:

- `#896` — numeric GC-array hot path regressed from near-JS speed to heavy helper-call/coercion overhead
- `#897` — pure recursive numeric `fib` regressed from Wasm-faster-than-JS to helper-call-heavy slowdown

Follow-on investigation also identified adjacent compiler cleanup work needed to keep the fixes from being blocked by conservative runtime machinery:

- `#898` — extend compile-time TDZ elimination to loop-local accesses
- `#899` — extend compile-time TDZ elimination to provably safe closure captures
- `#900` — move missing-`main()` handling out of runtime execution
- `#901` — remove helper-call coercion and numeric conversion churn from GC-array element access
- `#902` — remove helper-call coercion and numeric conversion churn from pure numeric recursion paths

These are compiler/codegen issues, not presentation/infrastructure work, so they belong after Sprint 32.

## Task queue

| Order | Issue | Title | Impact | Effort | Dev | Deps |
|-------|-------|-------|--------|--------|-----|------|
| 1 | #896 | Restore direct numeric GC-array codegen in hot loops | Critical — benchmark credibility | Medium | dev-1 | — |
| 2 | #901 | Remove helper-call coercion from numeric GC-array element access | High — root-cause isolation for #896 | Small | dev-1 | #896 |
| 3 | #898 | Support loops for compile-time TDZ checks | High — removes unnecessary loop runtime baggage | Medium | dev-1 | — |
| 4 | #897 | Restore direct numeric recursion codegen for fib hot path | Critical — benchmark credibility | Medium | dev-2 | — |
| 5 | #902 | Remove helper-call coercion from pure numeric recursive call/return paths | High — root-cause isolation for #897 | Small | dev-2 | #897 |
| 6 | #899 | Support closures for compile-time TDZ checks | Medium — removes conservative closure runtime baggage | Medium | dev-2 | — |
| 7 | #900 | Move missing-main checks out of runtime execution | Medium — reduce avoidable runtime scaffolding | Small | dev-2 | — |

## Notes

- `#896` and `#897` have exact WAT before/after evidence and benchmark deltas documented in their issue files.
- `#901` and `#902` split out the concrete technical causes already visible in the regressed WAT:
  helper-call coercion and repeated `f64`/`i32` conversion churn.
- `#898` and `#899` extend the already-landed TDZ work from `#800` into loops and closures, where the compiler is still conservative.
- `#900` captures the remaining runtime `main()` handling that should move to compile/load time.
- The regressions were discovered in the playground benchmark suite, but the fixes belong in the compiler/codegen, not the playground UI.
- The array and fib tracks can still be worked in parallel.

## Dev paths

**Dev-1**: #896, #901, #898 (array benchmark regression and loop-side cleanup)
**Dev-2**: #897, #902, #899, #900 (fib benchmark regression and runtime-cleanup follow-ons)

## Expected deliverables

1. Restore direct numeric GC-array codegen for the `bench_array` hot path
2. Restore direct numeric recursion codegen for the `fib` hot path
3. Remove helper-call coercion and avoidable numeric conversion churn from both hot paths
4. Eliminate unnecessary runtime TDZ checks in loop and closure cases that can be resolved statically
5. Move missing-`main()` handling out of runtime execution
6. Recover benchmark ratios to be materially closer to the earlier baseline
7. Add regression coverage so future codegen safety fixes do not silently reintroduce these slow paths

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
