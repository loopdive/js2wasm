---
title: "CI baseline drift investigation — reusable playbook"
date: 2026-04-11
sprint: Sprint-40
status: case-study
author: tech-lead
type: retrospective
tags: [ci, test262, investigation, bisect, playbook]
---

# CI baseline drift investigation — reusable playbook

## The incident in one paragraph

On 2026-04-11 around 19:07 UTC, the `benchmarks/results/test262-current.jsonl`
baseline on main silently flipped from **~22,157 pass / 1,326 compile_error** to
**~20,600 pass / 4,561 compile_error** — a ~1,500-test regression. Individual
PR CIs in the window reported positive deltas (+60 to +336); the cumulative
effect was strongly negative. Neither PR #96 nor PR #107 alone turned out to be
the direct cause under empirical revert probes. The regression deterministically
reproduces in GitHub Actions (push + workflow_dispatch events) but is zero
locally and zero on pull_request branch CIs tested against pre-flip main. The
investigation took ~2 hours and produced 8 structural CI-hardening issues
(#1076-#1082, #1084-#1087). This retrospective captures what worked, what
didn't, and the reusable investigation playbook so future tech leads don't
re-discover it.

## Reusable playbook: investigating a silent CI regression

### 1. Don't trust "CI passed" — read the artifact

`.claude/ci-status/pr-<N>.json` is a summary feed. **Read the raw
`test262-merged-report` artifact** via `gh run download <run-id> -n
test262-merged-report -D <out>`. The per-test jsonl is authoritative.
Summaries can lie — today's bug was that `ci-status-feed.yml` computed
`delta = pass - baseline` (absolute snapshot) rather than
`net_per_test = improvements - regressions`. See #1082 for the fix.

### 2. Compute `compile_ms=0` histogram as your first discriminator

Every test result entry has a `compile_ms`. Histogram the failing-test
`compile_ms` values. Three possible shapes:

- **Heavy 0-1ms tail**: the compiler is throwing on entry, not during real
  work. Points at: worker state corruption, global singleton poisoning,
  or shallow setup recursion.
- **Heavy hundreds-of-ms distribution**: the compiler is doing real work
  and then throwing. Points at: codegen bug, type-check bug, or test-
  specific semantic issue.
- **Uniform spread across the full range**: the regression is many small
  unrelated bugs, not one root cause. Stop looking for a single culprit.

The 2026-04-11 incident had **86.6% of regressed tests at compile_ms=0** and
**99.7% at compile_ms ≤ 1ms**. This was the single most useful signal: it
ruled out "slow compiler bug" and focused attention on state corruption /
entry-path recursion.

### 3. Match symptom counts to known structural constants

The regression was **3,266 "Maximum call stack size exceeded" compile
errors**. `scripts/compiler-fork-worker.mjs` has a
`RECREATE_INTERVAL = 200`. The sharded workflow runs **16 chunks**.
**16 × 200 = 3,200 ≈ 3,266.** Matching an observed count to a known
structural constant is a high-signal clue — it told us the bug is a
fork-worker state issue that recovers every 200 successful compiles.

### 4. Artifact-diff bisect, not local test reruns

GitHub Actions artifacts let you diff any two commits' test262 results
without running test262 again. Procedure:

```bash
gh run list --workflow="Test262 Sharded" --limit 40 --json databaseId,headSha,event,createdAt,conclusion
# for each suspect PR merge commit on main:
gh run download <run-id> -n test262-merged-report -D .tmp/<sha>
python3 -c "import json; r=json.load(open('.tmp/<sha>/test262-report-merged.json')); print(r['summary'])"
```

This is **100x faster than a local bisect**, survives runner resources you
don't have locally, and produces identical numbers to what CI reported.
Use it whenever you have enough runs on origin to cover the bisect
window.

### 5. Empirical revert probes are better than inspection audits

Source audits can miss things. They missed bodyUsesArguments recursion
the first time (dev-1031 cleared #96 via a state-contamination lens
before realizing the stack-deepening dimension was orthogonal). They
missed walkInstructions compounding the first time too.

**Revert probe PRs are faster and more reliable than audits** when the
hypothesis is "PR X introduced the regression":

1. `git checkout -b test/revert-<N>-probe main`
2. `git revert -m 1 <merge-commit-of-PR-N> --no-edit`
3. `git push origin test/revert-<N>-probe`
4. `gh pr create --base main ...` with "DO NOT MERGE" in the body
5. Wait ~20 min for CI
6. Read the artifact via `gh run download`

A positive result (clean CI) is a strong confirmation. A null result
(still broken) is also informative — it exonerates the PR. Today we ran
three revert probes (#112 -#96, #113 -#107, #114 all-three) in ~60
minutes. Each eliminated one hypothesis.

### 6. Audit under TWO dimensions, not one

When auditing a suspect PR for a compile-time crash, check BOTH:

- **State contamination**: does the PR add module-level mutable storage
  that could persist across compiles? (Map, Set, WeakMap, singleton
  registries, ts.Symbol table mutations)
- **Stack deepening**: does the PR add a recursive AST walker, a new
  pre-codegen pass, or new call sites to an existing recursive walker?
  Stack depth composes additively when one recursive walker runs inside
  another — `compile_depth + ast_walk_depth + wasm_block_depth`, not
  `max()` of them.

The two dimensions are **orthogonal**. A PR can be clean on one and
guilty on the other. Today's audit methodology error was checking only
state contamination for #96 and #107; neither was contaminating state,
but both added stack frames to a composition path that compounded past
the CI stack budget.

Lesson saved to memory as `feedback_audit_two_dimensions.md` (TBD).

### 7. Event-type divergence is a big signal

GitHub Actions event types are NOT interchangeable:

- **`pull_request` events** test a synthetic `refs/pull/N/merge`
  (branch merged into current base at CI run time).
- **`push` events** test the single tip commit.
- **`workflow_dispatch` events** test the ref at dispatch time.

If the same commit produces different results under different event
types, the variable is something outside the source — cache scope,
matrix concurrency, runner image, cgroup limits, or the synthetic merge
ref's content. Today the bug deterministically reproduced on push +
workflow_dispatch but not on pull_request. The conclusion wasn't that
the bug is event-type-specific — it's that PR-event CIs of the same
commit before the flip happened to test a pre-flip baseline, masking
the regression from any single PR's signal.

### 8. Baseline drift is a first-class failure mode

PR CI compares against `benchmarks/results/test262-current.jsonl` as
committed on main. If main's baseline is stale (doesn't reflect
accumulated regressions), every PR's CI inherits the stale reference
and reports regressions as "already in baseline, not my fault." Regressions
compound silently. See #1076 (split merge job so main always refreshes)
and #1081 (commit-hash-indexed cache so PR CI compares against merge-base).

**Rule**: if the baseline hasn't refreshed in >30 minutes of merge
activity, stop merging and trigger a manual `workflow_dispatch -f
allow_regressions=true` to force a fresh baseline commit. Landing page
drift > 1 hour is a strong leading indicator.

### 9. Cross-check regressions across PRs before counting them

dev-1053's `feedback_baseline_drift_cross_check.md` memory rule: when
sampling regressions in a PR's CI, cross-check against regressions
reported in OTHER unrelated open PRs from the same baseline. Identical
regression clusters across unrelated PRs are **baseline drift artifacts**,
not real regressions from either PR. Today this caught dev-1047's 16-test
DataView cluster on PR #100 (also appeared on PR #102, PR #107) as
inherited drift, not PR #100's fault.

## Things that didn't work

### Frozen-baseline self-merge gate

The `/dev-self-merge` criteria used `delta > 0` where `delta` was the
absolute snapshot number, not per-test net. A PR could ship +150
improvements and −200 regressions as `delta = +150` and pass the gate.
12 PRs self-merged in a window of ~2 hours; cumulative deltas claimed
+2,778 pass, reality was −1,206. **Always gate on `net_per_test`, not
`snapshot_delta`.** Fixed in #1082.

### Single-audit-dimension methodology

Source audits cleared #96 and #107 the first pass because the auditor
was looking for state contamination (WeakMaps, singletons). The real
vector was stack composition — independent issue. Dual-dimension audit
would have caught it.

### "Revert until it recovers" as the fallback

Reverting always has a cost: you lose the work the PR delivered. And
today it didn't even work — three revert probes failed to recover the
baseline, proving the bug isn't cleanly attributable to any single PR.
If the first revert probe fails, **pivot to a class-level fix** (make
the walker iterative, add a depth guard, etc.) rather than keep
reverting.

## Things that worked well

### Parallel investigation with different methodologies

Today had three devs + tech lead running parallel angles:
- **dev-1031**: source audit with state-contamination + stack-deepening lenses
- **dev-1053**: artifact-diff bisect + local chunk-1 repro + compile_ms histogram
- **dev-1047**: fork-worker compile-count bypass analysis
- **tech lead**: revert probe PRs + CI run comparison

Each approach had a blind spot the others didn't. The combination
surfaced both a real class-level bug (walker recursion composition) and
a real CI infra bug (baseline drift + snapshot_delta).

### Pipeline PAUSE during investigation

Broadcasting `PAUSE — no merges, no new code` stopped the accumulation
of new regressions while we investigated. Devs picked read-only
investigation tasks instead of coding. This preserved enough state to
do clean bisects without new merges mudding the water.

### Pre-draft fixes during investigation

dev-1031 drafted the iterative `bodyUsesArguments` fix + the iterative
`walkInstructions` fix + issue stubs #1085/#1086/#1087 **while** the
revert probes ran. When a probe confirms, the fix is ready to ship
immediately. When it doesn't, the draft is still valid pre-emptive
hardening. Zero wasted work.

### Filing structural fixes during incident, not after

Within the first 30 minutes of the investigation, we had #1076-#1082
filed covering: split merge job, fresh baseline fetch, emergency
dispatch path, age stamp visibility, commit-hash-indexed cache,
net_per_test fix. The structural fixes are what prevents recurrence;
filing them during the incident captures the context perfectly. Filing
them later loses detail.

## Reusable artifacts

- **`.claude/skills/tech-lead-loop.md`** — 5-phase orchestration skill
- **`plan/investigations/2026-04-11-baseline-regression-bisect.md`** —
  dev-1053's investigation writeup
- **Issue files #1076–#1082, #1084–#1087** — structural CI hardening
- **`.claude/memory/feedback_baseline_drift_cross_check.md`** — drift
  recognition rule

## Recommendations for the next tech lead

1. **Read this retrospective when you see unexplained pass-count swings**
   on main. The playbook above skips you past the first hour of
   re-discovery.
2. **Install `/check-baseline-health` as a 30-min loop task** once the
   structural fixes land — monitor pass count, regression age, drift.
3. **Never merge a PR with > 10% regression ratio** regardless of
   cluster justification. If there's a legitimate narrow cluster, file
   a follow-up issue that removes the affected tests from the baseline,
   THEN merge.
4. **Treat the self-merge gate as advisory, not authoritative.** The
   gate catches most bad PRs but can miss structural issues. Keep
   tech-lead review as the final call for anything touching core
   codegen paths.
5. **Spawn devs with specific read-only investigation shapes**, not
   open-ended "help investigate". Today's success was because each
   dev had a precise methodology pointer.

## Token budget note

This investigation consumed ~600k Opus tokens across tech lead + 4 devs
over ~2 hours. A Sonnet tech lead would have made more hypothesis
errors but at ~5x lower cost per token. The investigation's breakthroughs
came from the **devs**, not the tech lead synthesizer — dev-1053's
compile_ms histogram and dev-1031's stack-deepening re-audit were the
key moves. Tech lead orchestration could plausibly run on Sonnet with
the `tech-lead-loop` skill, escalating to Opus for crisis synthesis
moments like this one. See the conversation where this was proposed.
