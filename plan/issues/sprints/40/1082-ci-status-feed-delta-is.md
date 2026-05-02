---
id: 1082
title: "ci-status-feed delta is absolute snapshot not per-test regression — lies to dev-self-merge gate"
status: done
created: 2026-04-11
updated: 2026-04-11
completed: 2026-04-14
priority: critical
feasibility: easy
reasoning_effort: low
task_type: bugfix
goal: ci-hardening
parent: 1080
---
# #1082 — ci-status-feed `delta` is a lie

## Problem

`.github/workflows/ci-status-feed.yml` computes `delta = pass - baseline`
where `baseline` is read from the committed `benchmarks/results/test262-current.json`
on main. This is an **absolute snapshot comparison**, not a per-test regression
count.

The `/dev-self-merge` skill reads `.claude/ci-status/pr-<N>.json`, looks at
`delta`, `improvements`, `regressions`, `ratio = regressions / improvements`,
and decides whether the PR is eligible to merge. Because the feed's `delta`
conflates "absolute pass count change" with "per-test net regression", a PR
that adds 250 improvements and introduces 100 real regressions shows up as
`delta = +150, improvements = 250, regressions = 100, ratio = 40%` in the
best case — or worse, if the baseline was itself already degraded, as
`delta = +150, improvements = 250, regressions = N` where `N` understates
the true count because both the committed baseline and the PR's branch-point
baseline already contained the prior regressions.

Meanwhile `scripts/diff-test262.ts` (used by the `merge` job in
`test262-sharded.yml`) computes the correct per-test diff against the
committed baseline. **That correct count is never published through the
feed**. It only appears in the failed `merge` job log, which the dev
self-merge skill does not read.

**Evidence**: 2026-04-11 baseline drift incident. 12 PRs self-merged over
~2 hours based on positive `delta` and low `ratio` from the feed. Real
aggregate effect: −1,206 pass tests (21,750 → 20,544). The per-PR deltas
claimed +2,778 combined. The gap was entirely in the `delta` metric lying
about what it measured.

## Root cause

`.github/workflows/ci-status-feed.yml` lines ~89-93 (exact line may drift):

```yaml
# Current (wrong):
PASS=$(jq -r '.summary.pass' merged-reports/test262-report-merged.json)
BASELINE_PASS=$(jq -r '.summary.pass' benchmarks/results/test262-current.json)
DELTA=$((PASS - BASELINE_PASS))
echo "{ \"pr\": $PR, \"pass\": $PASS, \"delta\": $DELTA, ..., \"improvements\": $IMPR, \"regressions\": $REGR }"
```

The `IMPR` and `REGR` counts are parsed from `test262-regressions.txt`
(which `diff-test262.ts` writes) — those are per-test and correct. But
`DELTA` is the wrong calculation and should never have been published
alongside them.

## Fix

Replace `DELTA = PASS - BASELINE_PASS` with `DELTA = IMPR - REGR`. The
"net improvement" the feed should publish is the **per-test net**, not the
**absolute snapshot net**. These differ whenever the committed baseline is
not itself the result of running the exact same shard set as the PR — which
is **always** in practice.

Alternative fix (safer): **rename the field** from `delta` to
`snapshot_delta` and add a new field `net_per_test = IMPR - REGR`. The
self-merge skill and any dashboards then migrate to `net_per_test`. This
preserves backward compatibility with any existing consumer of `delta`.

**Recommended**: the alternative. Don't change the meaning of an existing
field — add a new one and deprecate the old.

## Dependent skill update

`.claude/skills/dev-self-merge.md` reads `delta` from the feed. Update it
to read `net_per_test` (or, if the straight rename is taken, keep reading
`delta` but update the comment explaining what it means). Crucially, the
self-merge criterion should be:

- `net_per_test > 0` — more improvements than regressions introduced by
  this specific PR
- `regressions / improvements < 10%` — ratio gate (already correct)
- no single error bucket > 50 regressions (already correct)

All three criteria operate on the per-test counts. The absolute snapshot
delta should not be a merge criterion.

## Scope

1. Edit `.github/workflows/ci-status-feed.yml` — add `net_per_test` field,
   rename `delta` → `snapshot_delta` OR keep `delta` as a semantic alias.
2. Edit `.claude/skills/dev-self-merge.md` — use `net_per_test` as the
   first gate, document the distinction between the two in the "What
   the fields mean" section.
3. Edit `.claude/hooks/ci-status-watcher.sh` (if it parses the feed) —
   update any field it surfaces to devs.
4. Regenerate existing `.claude/ci-status/pr-*.json` files to include both
   fields for past PRs — or, simpler, leave them as-is and only fix new
   writes going forward.

## Acceptance criteria

- [ ] `.claude/ci-status/pr-<N>.json` written after this lands contains both
      `snapshot_delta` and `net_per_test` (or equivalent).
- [ ] `/dev-self-merge` skill references `net_per_test` as its first gate.
- [ ] A synthetic dry-run: simulate a feed payload with `snapshot_delta =
      +150` but `net_per_test = −50` and verify the skill would refuse to
      merge.
- [ ] Retrospective check against the 12-PR drift window: recalculated
      `net_per_test` for each of the 12 PRs shows which ones would have
      been flagged as ineligible under the new rule.

## Risks

- **Backward compatibility for existing PR status files**: new devs will
  see mixed old + new field shapes in `.claude/ci-status/*.json` for a
  while. Mitigate by keeping both field names during the transition.
- **Potentially more PRs flagged ineligible** once the signal is honest:
  this is intended, not a risk.

## Relationship

- Parent: **#1080** umbrella (CI baseline-drift gate).
- Related: **#1081** (commit-hash-indexed cache) — eliminates the drift
  problem at the source; **#1082** is the tactical fix that stops the
  lying signal independent of the cache architecture.
- Discovered by: dev-1047 during read-only investigation of the 2026-04-11
  baseline drift incident.

## Notes

- **This is the highest-priority #1080 child** because it fixes the
  primary cause of devs merging bad PRs. #1076-#1079 and #1081 are the
  deeper structural fixes; #1082 is the "stop the bleeding" fix.
- **Pause exception**: fixing #1082 does not introduce new compiler changes
  and does not risk further regressions — it only improves the signal
  devs read. Tech lead may authorize implementation during the pause as
  a workflow-only emergency fix.
