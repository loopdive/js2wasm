---
id: 1190
title: "research: eliminate CI test262 baseline drift (umbrella for #1189, #1191, #1192)"
status: done
created: 2026-04-27
updated: 2026-04-27
completed: 2026-04-30
priority: high
feasibility: medium
reasoning_effort: max
task_type: research
area: infrastructure
goal: ci-hardening
resolution: split into sub-issues — major drift sources addressed in sprint 45/46, remaining work tracked discretely
es_edition: n/a
related: [1185, 1186, 1189, 1191, 1192]
origin: project lead requested 2026-04-27 after PR #72 + #74 both blocked on baseline-corruption false regressions (see those PRs' escalation messages).
---
# #1190 — Research: eliminate CI test262 baseline drift

## Problem

PR #72 (#1185 IR refactor) and PR #74 (#1186 legacy single-site fix)
both showed -200+ net regressions in CI vs the cached baseline. Both
were architecturally incapable of regressing 200 tests — verified
by 95% regression overlap between unrelated PRs and by local
reproduction (sampled regressions compile cleanly on the PR branch
HEAD).

Yet the CI gate (`net_per_test > 0`) blocks every honest PR. The
cost of a single false-blocked PR is high: ~30 minutes of
investigation per dev escalation + admin merge override + erosion
of trust in the gate metric.

This issue is the **umbrella research task** for sprint 46:
diagnose the full chain of drift sources, design a coherent fix
strategy, and break it into sub-issues for execution.

The diagnostic work has already produced two specific fix
candidates (#1189, #1191, #1192). This issue covers the **rest**:
what other drift sources exist, what's the right end-state metric,
and how do we keep the system honest going forward.

## Drift sources observed (so far)

  1. **CI cache leaks stale "pass" entries across compiler changes.**
     The `test262-sharded.yml` `restore-keys` fallback matches any
     chunk for the same hash. → fix in #1189.

  2. **Committed `test262-current.jsonl` is 1634 tests behind
     reality.** Local: 25387 pass; CI cache produces 27021. The
     committed file is what some `dev-self-merge` paths read; the
     gap creates a parallel drift surface. → fix in #1191.

  3. **`compile_timeout` is counted as a regression.** ~50% of
     PR #72/#74 "regressions" are compile_timeout transitions
     (pass → CT) that reflect runner load / timing variance, not
     compiler behavior. The 30s compile timeout is a hard cliff. →
     classification fix in #1192.

  4. **Test runner non-determinism.** Some tests flap between
     pass and fail on consecutive runs. Sources include: test
     ordering, shard partitioning, Node garbage collection timing,
     Wasm-engine compile-time variance. Need to quantify.

  5. **`js2wasm-baselines` repo and main repo's `test262-current.jsonl`
     can disagree.** Two-source-of-truth. Need to reconcile.

## Research questions

  - **Q1**: How much of the observed regression count is driven by
    each source? (Run controlled experiments: re-run CI on the same
    SHA twice, measure flip rate; refresh baseline cleanly, measure
    delta with cache off; etc.)

  - **Q2**: What's the right merge-gate metric? Options:
    - `net_per_test` against committed baseline (what main reflects)
    - `net_per_test` against latest CI run on `main` HEAD (avoids
      committed-baseline lag)
    - `regressions of (CE + fail) only` (excludes CT noise)
    - Statistical: regression count vs the 95th percentile of
      no-op-PR regression counts (drift control)

  - **Q3**: What's the cheapest way to validate a no-drift state?
    Could a smoke-canary workflow run CI twice on `main` HEAD with
    a fresh cache and report the delta? If the delta is non-zero,
    that's pure drift quantification.

  - **Q4**: How do we prevent baseline-file corruption from
    propagating? Auto-validate `test262-current.jsonl` on every
    PR by spot-checking 50 random "pass" entries against
    `runTest262File` — if any disagree, fail the PR with a clean
    error pointing at the baseline.

  - **Q5**: Can we eliminate the cache entirely on baseline-refresh
    runs (the chore commits)? They'd be slower (~80 CPU-min) but
    correct by construction. Cache stays for regular PR validation.

## Proposed sub-issues (extract during research)

Already filed, depend on this:
  - **#1189**: cache-key staleness fix (drop restore-keys, tighten
    hashFiles, add cache-version bump knob)
  - **#1191**: refresh committed `test262-current.jsonl` to match
    reality, automate periodic refresh PRs
  - **#1192**: separate CT noise from regression count in
    `dev-self-merge` skill + CI status feed

Likely to surface during research:
  - Auto-validate baseline on PR (spot-check N pass entries)
  - Smoke-canary: re-run main HEAD twice, measure flip rate
  - Migrate baseline-refresh runs to no-cache mode
  - dev-self-merge skill: make committed-baseline comparison the
    primary check, CI-cache the secondary

## Acceptance criteria

This is a research issue. Acceptance:

1. Document **measured** drift contribution from each source. Numbers,
   not estimates.
2. Choose a **target** end-state merge-gate metric. Document the
   trade-off.
3. File any additional sub-issues surfaced during research.
4. Update `dev-self-merge.md` skill with the new metric (likely a
   sub-issue itself — file as part of the research output).
5. Land a **canary mechanism** to detect future drift regressions
   (smoke check or statistical baseline). Sub-issue.
6. Verify on a no-op PR (touches only docs) that the post-fix CI
   reports zero regressions (proves drift is gone).

## Time budget

This is a max-reasoning-effort research issue. Suggest blocking
~1 day for the diagnosis + sub-issue write-up, then sub-issues
get their own budgets.

## Why this matters

Current state: every IR-refactor or non-trivial-diff PR triggers a
~30-minute drift investigation. With ~10 such PRs per week that's
~5 hours/week of dev time spent on a problem that's structurally
fixable. ROI on resolving this is high — frees time for actual
compiler / spec work.

## Notes from PR #72 + #74 investigation (2026-04-27)

  - Local-reproduction smoke check ("does this regression actually
    happen on the PR branch?") was decisive in both cases. The
    `dev-self-merge` skill should encourage / require this check
    before escalation. → consider adding it to the skill as
    "step 1.5: sample 5 regressed tests locally on branch HEAD".

  - The `feedback_baseline_drift_cross_check.md` memory note is
    correct in principle but underspecified in mechanism. Dev had
    to manually grep across `pr-*.json` files. A built-in
    "compare regression sets across recent PRs" tool would make
    the cross-check trivial.

  - Both PRs eventually escalated to admin merge after the manual
    investigation. That's fine for once but signals a process
    smell — the gate is producing too many false positives.

## Closure note (2026-04-30)

Closing this umbrella as **done — split into sub-issues**.

### What landed

| Sub-issue | Sprint | PR |
|---|---|---|
| #1189 (cache-key staleness diagnosis) | 46 | wont-fix — correct diagnosis: not cache, CT noise (#1171 already fixed cache invalidation) |
| #1191 (committed baseline refresh + automation) | 45 | done |
| #1192 (CT exclusion from regression count) | 45 | done |
| #1193 (ci-status-watcher push notifications) | 45 | done |
| #1213 (refresh-benchmarks LFS-migration path mismatch) | 46 | PR #105 |
| #1214 (refresh-benchmarks runner-noise gate) | 46 | PR #108 |

### What didn't land here, tracked as sprint-47 sub-issues

| Sub-issue | Concern |
|---|---|
| **#1216** | Auto-commit playground benchmark baseline on push-to-main (Option A from #1214; would re-enable PR-event regression gating) |
| **#1217** | Smoke-canary mechanism (this umbrella's AC #5: detect future drift regressions by re-running main HEAD twice with fresh cache) |
| **#1218** | Auto-validate committed test262 baseline on PR (this umbrella's Q4: spot-check 50 random pass entries against runTest262File) |

### What remains as open research (not filed)

- **Q2 (statistical merge-gate metric)**: replace fixed `net_per_test > 0` with "drift > 95th percentile of no-op-PR drift count". Requires controlled measurement first; intentionally NOT filed yet — file it after #1217 produces real flip-rate numbers.

### Why split rather than keep umbrella open

The umbrella served its purpose: it organized the research, surfaced the right sub-issues, and drove four landed PRs across sprints 45/46. The remaining work is execution (smoke-canary, auto-validate, baseline auto-commit), not research. Discrete sprint-47 issues are easier to schedule and accept than a perpetual umbrella.

### Acceptance criterion #6 status

> "Verify on a no-op PR (touches only docs) that the post-fix CI reports zero regressions (proves drift is gone)."

**Not met.** Empirical evidence from PR #104 (docs/scripts only): -26 net pass, 48 non-CT regressions, 121 improvements. The post-#1192 metric is *better* (CT noise excluded), but residual drift in `other`/`promise_error`/`type_error` categories persists. Closing this AC against #1217 (canary will measure the residual) and #1218 (validator will catch baseline corruption that contributes to it).
