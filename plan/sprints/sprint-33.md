# Sprint 33 — Benchmark Regression Recovery

**Date**: 2026-04-03
**Goal**: Recover benchmark credibility after codegen regressions were discovered in the playground benchmark suite
**Baseline**: 15,526 pass / 42,934 official (36.2%) — post sprint-35 final

## Context

While validating the public benchmark suite for STF/demo use, two concrete performance regressions were identified:

- `#896` — numeric GC-array hot path regressed from near-JS speed to heavy helper-call/coercion overhead
- `#897` — pure recursive numeric `fib` regressed from Wasm-faster-than-JS to helper-call-heavy slowdown

Follow-on investigation also identified adjacent compiler cleanup work:

- `#898` — extend compile-time TDZ elimination to loop-local accesses
- `#899` — extend compile-time TDZ elimination to provably safe closure captures
- `#900` — move missing-`main()` handling out of runtime execution
- `#901` — remove helper-call coercion from GC-array element access
- `#902` — remove helper-call coercion from pure numeric recursion paths

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

## Dev paths

**Dev-1**: #896 → #901 → #898 (array benchmark regression and loop-side cleanup)
**Dev-2**: #897 → #902 → #899 → #900 (fib benchmark regression and runtime-cleanup follow-ons)

## Status (2026-04-03)

Both dev paths dispatched as teammates. In progress.

## Results

| Order | Issue | Pre-merge pass | Post-merge pass | Delta | Status |
|-------|-------|---------------|----------------|-------|--------|

## Retrospective

(To be filled after sprint completion)
