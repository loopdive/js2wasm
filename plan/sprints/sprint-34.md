# Sprint 34 — Benchmark Regression Recovery

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

Complete. All 7 issues resolved.

## Results

| Order | Issue | Pre-merge pass | Post-merge pass | Delta | Status |
|-------|-------|---------------|----------------|-------|--------|
| 1 | #896 | 17,583 | pending test262 | perf (null guard elimination) | merged |
| 2 | #901 | — | — | — | already fixed by #896 |
| 3 | #898 | pending | pending test262 | perf (loop TDZ elimination) | merged |
| 4 | #897 | — | — | — | already fixed on main |
| 5 | #902 | — | — | — | already fixed on main |
| 6 | #899 | pending | pending test262 | perf (closure TDZ elimination) | merged |
| 7 | #900 | pending | pending test262 | infra (compile-time main() detection) | merged |

Final test262 numbers: pending (run in progress)

## Retrospective

### What went well
- **Smoke-testing before coding** — dev-2 verified #897 and #902 were already fixed before writing any code. Saved significant time.
- **Parallel dev paths worked** — array track (dev-1) and fib track (dev-2) ran independently with no file conflicts.
- **#898 TDZ analysis is a solid architectural contribution** — `needsTdzFlag()` does proper static analysis instead of conservative flag allocation. Eliminates dead code in hot loops.
- **#900 compile-time metadata** — `hasMain`/`hasTopLevelStatements` on `CompileResult` is clean API design that benefits playground, CLI, and future tooling.

### What went wrong
- **OOM crash from concurrent equiv tests** — both agents ran equiv tests simultaneously, spawning ~20 vitest forks. Swap filled (974/1023 MB), killed the tech lead process. Fix applied: fork-per-file vitest config.
- **dev-1 also implemented #900** despite dev-2 already doing it — the message telling dev-1 to focus only on #898 arrived after it had started. Wasted work, needed manual conflict resolution.
- **dev-1 crashed without committing** — 64 lines of uncommitted work sat in worktree until tech lead manually reviewed, committed, and cherry-picked.
- **Only 1 dev initially dispatched for 3 independent issues** — user had to point out dev-2 should handle #900 separately.

### Process improvements
1. **Fork-per-file equiv tests** — vitest.config.ts changed to `singleFork: false`. Eliminates memory accumulation (+157 more tests pass). Also discovered #923: compiler leaks state between `compile()` calls.
2. **Always dispatch max parallel devs** for independent issues — don't serialize when work can be parallelized.
3. **Verify agent received narrowed scope** before it starts coding — check for confirmation message.
