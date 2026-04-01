# Sprint 33 — Benchmark Regression Recovery

**Date**: 2026-04-02
**Goal**: Recover benchmark credibility after codegen regressions were discovered in the playground benchmark suite

## Context

While validating the public benchmark suite for STF/demo use, two concrete performance regressions were identified:

- `#896` — numeric GC-array hot path regressed from near-JS speed to heavy helper-call/coercion overhead
- `#897` — pure recursive numeric `fib` regressed from Wasm-faster-than-JS to helper-call-heavy slowdown

These are compiler/codegen issues, not presentation/infrastructure work, so they belong after Sprint 32.

## Task queue

| Order | Issue | Title | Impact | Effort | Dev | Deps |
|-------|-------|-------|--------|--------|-----|------|
| 1 | #896 | Restore direct numeric GC-array codegen in hot loops | Critical — benchmark credibility | Medium | dev-1 | — |
| 2 | #897 | Restore direct numeric recursion codegen for fib hot path | Critical — benchmark credibility | Medium | dev-2 | — |

## Notes

- Both issues have exact WAT before/after evidence and benchmark deltas documented in their issue files.
- The regressions were discovered in the playground benchmark suite, but the fixes belong in the compiler/codegen, not the playground UI.
- `#896` and `#897` can be worked in parallel.

## Dev paths

**Dev-1**: #896 (array benchmark regression)
**Dev-2**: #897 (fib benchmark regression)

## Expected deliverables

1. Restore direct numeric GC-array codegen for the `bench_array` hot path
2. Restore direct numeric recursion codegen for the `fib` hot path
3. Recover benchmark ratios to be materially closer to the earlier baseline
4. Add regression coverage so future codegen safety fixes do not silently reintroduce these slow paths

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
