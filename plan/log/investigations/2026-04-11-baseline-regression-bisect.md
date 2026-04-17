---
author: dev-1053
date: 2026-04-11
status: awaiting dispatch run 24290074987
related_runs:
  - 24289210403 (push @ 61e09d36, healthy)
  - 24289613969 (push @ fc4b06c8, broken)
  - 24290074987 (workflow_dispatch @ main, probe)
---

# Sprint 41 test262 baseline regression — bisect report

## TL;DR

Main's test262 sharded baseline dropped from 22,160 pass / 19 stack overflows
(commit 61e09d36) to 20,624 pass / 3,266 stack overflows (commit fc4b06c8),
a drop of 1,536 pass. **The regression is not reproducible on the PR branch
runs of any of the four PRs that merged in the window. Source code and
workflow file are identical between the healthy PR branch runs and the broken
push-to-main run. The failure mode is a worker-state corruption pattern
(compile_ms=0 instant throws) that only manifests at full 43K-test scale in
the push-to-main event.**

The working hypothesis is **not** a PR source bug — it is either (a) CI
non-determinism (flakiness under load) or (b) event-type-dependent CI
environment divergence (pull_request vs push). The dispatched probe run
24290074987 discriminates between these two.

## Timeline of commits in the window

| Commit   | PR   | Issue | Subject                                           |
|----------|------|-------|---------------------------------------------------|
| 61e09d36 | #106 | #1063 | inline instr clone (last healthy pin)             |
| 4ce6f5d1 | #86  | #1037 | Symbol.dispose well-known symbols                 |
| 2dc095ac | #100 | #1057 | vec struct constructor runtime dispatch           |
| ddcc5770 | #96  | #1053 | arguments.length via module-global extras-argv    |
| fc4b06c8 | #107 | #1064 | DataView subview metadata for bounds errors       |

Commits BEFORE 61e09d36 (already verified healthy via main-pr106 artifact):
#95 (4ecf4130 module-resolver), #101 (b16e0388 async-gen dstr), #91
(cb8088ed derived-eval-super), #103 (4cbc5f07 array-dstr-iter),
#98 (1c809729 multisource-allowjs). These five PRs all ran clean under main's
own sharded CI and can be ruled out.

## Evidence

### Artifact-level pass/fail counts

| Run                                         | pass   | fail   | CE    | range_error (stack) |
|----------------------------------------------|--------|--------|-------|---------------------|
| main-pr106 push (61e09d36, last healthy)     | 22,160 | 18,335 | 1,325 | **19**              |
| pr-86 branch CI                               | 21,523 | 18,831 | 1,459 | **19**              |
| pr-100 branch CI                              | 22,046 | 18,448 | 1,325 | **19**              |
| pr-96 branch CI                               | 22,101 | 18,359 | 1,359 | **19**              |
| pr-107 branch CI                              | 22,188 | 18,307 | 1,325 | **19**              |
| main-fc4b06c8 push (broken)                   | 20,624 | 16,636 | 4,561 | **3,266**           |
| main-now push (== fc4b06c8)                   | 20,624 | 16,636 | 4,561 | **3,266**           |

Every single PR branch run in the window hits 19 stack overflows — the
baseline level. Only the push-to-main run at fc4b06c8 jumps to 3,266.

### Error-category diff, pr-107 → main-fc4b06c8 (identical source)

```
range_error:    +3,247
assertion_fail:   -685
type_error:       -713
runtime_error:     -60
null_deref:        -32
```

The +3,247 range_errors are almost exactly counterbalanced by −3,240
regressions from other buckets — tests that previously reached runtime or
wasm-compile no longer survive the compiler.

### compile_ms distribution of the 3,266 stack overflows

| Bucket      | Count | Share |
|-------------|-------|-------|
| **0 ms**    | 2,830 | 86.6% |
| ≤ 1 ms      | 3,255 | 99.7% |
| ≤ 10 ms     | 3,261 | 99.8% |
| max = 33 ms |       |       |

**These are instant throws on entry, not recursive blow-ups.** Normal compiles
run in hundreds of ms. A compile that throws "Maximum call stack size
exceeded" in 0 ms means the compiler state was already unrecoverable before
the test source got touched.

### Shape fits fork-worker state corruption

`compiler-fork-worker.mjs` recreates the incremental TypeScript compiler
every `RECREATE_INTERVAL = 200` compiles. `3,266 ≈ 16 × 200`. Across
16 shards × 4 pool workers = 64 fork processes, ~16 poisoning events would
each produce exactly ~200 "compile_ms ≈ 0" failures until the 200-count
triggers `createFreshCompiler()`.

Interpretation: a specific test file poisons the incremental compiler's
internal state (likely a cycle in the TypeScript language service's scope
chain or checker), and every subsequent `inc.compile()` throws instantly
until recreation. The poison test itself passes or fails normally; the
200-test tail is collateral damage.

### Workflow / infrastructure is unchanged

```
git log 61e09d36..fc4b06c8 -- .github/workflows/ scripts/run-test262-vitest.sh \
    scripts/compiler-fork-worker.mjs scripts/compiler-pool.ts \
    scripts/compiler-bundle-entry.ts tests/test262-shared.ts tests/test262-runner.ts
# → (empty)
```

No changes to any CI-side file. Same workflow, same shard count, same
`COMPILER_POOL_SIZE=4`, same node 25 runner image. Cache key is
`hashFiles('src/**/*.ts')` — identical by construction for identical src.

### Local reproduction — negative

- `npx tsx` + plain `compile()` on each of the three first regressed
  TDZ tests: all pass in 200–600 ms.
- Worktree-built `scripts/compiler-bundle.mjs` + `createIncrementalCompiler`
  (same path as `compiler-fork-worker.mjs`) on `Array/prototype/concat/name.js`:
  both plain and incremental compile OK.
- Sequential run of 288 const/let TDZ tests through the incremental compiler:
  zero stack overflows.

The poison is somewhere in the 43K test set, and its effect is only visible
at full-scale shard ordering.

## Hypotheses

### H1 — CI non-determinism (flakiness under load)

The same commit produces different results on different runs. Shape fits
if the compiler has a latent race or allocator-sensitive recursion that
only trips under specific GC timing. Detection: the dispatch run
24290074987 comes back healthy (~22,180 pass).

**Fix shape:** structural CI hardening — mandatory N-of-M run-stability
gate before baseline promotion, no source change. Open #1083.

### H2 — Event-type-dependent environment divergence

Something in the GitHub Actions environment differs between
`pull_request` and `push` events that affects the fork-worker's JS heap
or stack size in a way that unmasks a latent compiler bug. Detection:
the dispatch run reproduces ~20,624 pass.

**Fix shape:** identify the environment delta, then either pin the
environment explicitly or forward-fix the latent compiler recursion.
Candidates for the delta:
- Cache restore behavior (pull_request writes to a ref-scoped cache,
  push reads from default branch cache — different contents possible
  even with matching key)
- `GITHUB_REF` affecting any runner setup step
- Concurrency-group cancellation semantics (test ordering under pressure)
- Runner image version drift between event types

### H3 (ruled out) — PR source regression

Disproven by identical pr-107 branch run (19 stack) vs main-fc4b06c8
push run (3,266 stack) on identical source. No PR in the window can be
the cause.

## Recommended actions

1. **Wait for dispatch run 24290074987** (~20 min from 19:40 UTC).
2. **If H1 (pass ~22k)**: file #1083 "Mandatory N-of-M run-stability gate
   before baseline promotion" and unpause the pipeline. Baseline auto-heals.
3. **If H2 (pass ~20k)**: open bisect on the event-type dimension. Start
   by diffing the actual shard env vars between a pr-107 shard job and a
   main-fc4b06c8 shard job via `gh run view --log`.
4. **Do not revert any PR in the window** regardless of outcome. The
   source is exonerated by the identical-src evidence.

## Data sources

All artifacts cached under `/tmp/bisect/`:
- `main-pr106/` — push run at 61e09d36 (run 24289210403), last healthy
- `main-fc4b06c8/` — push run at fc4b06c8 (run 24289613969), broken
- `pr-{86,96,100,107}/` — PR branch runs for the four in-window PRs
- `pr-{90,91,92,93,94,95,98,101,103,106}/` — PR branch runs for pre-window PRs,
  used to confirm those PRs were healthy before merge

Probe scripts under worktree `.tmp/`:
- `.tmp/tdz-probe.mjs` — local TDZ const/let reproduction attempt
- `.tmp/stack-probe.mjs` — concat/name.js et al via plain tsx
- `.tmp/inc-probe.mjs` — 288 const/let via createIncrementalCompiler
- `.tmp/bundle-probe.mjs` — concat/name.js via compiler-bundle.mjs
  (plain + incremental)
