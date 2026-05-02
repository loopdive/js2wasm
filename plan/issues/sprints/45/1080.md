---
id: 1080
title: "[umbrella] Fix CI baseline-drift regression gate — main is not self-healing"
status: done
created: 2026-04-11
updated: 2026-04-30
completed: 2026-04-29
priority: critical
feasibility: medium
reasoning_effort: medium
task_type: bugfix
goal: ci-hardening
blocks: [1076, 1077, 1078, 1079]
---
> **Closed 2026-04-30 (PO).** All four umbrella children landed in
> Sprint 45: #1076 (split merge job), #1077 (PR CI fetches fresh
> baseline at runtime), #1078 (emergency dispatch path), #1079
> (baseline age stamp on landing page). The umbrella's acceptance
> criteria are met by the sum of the children. Moving from S46 to
> S45 to reflect the actual sprint of completion. The S46 carry-over
> tag was historical noise from when the umbrella file was created.


# #1080 — [umbrella] CI baseline-drift regression gate

## Problem

On 2026-04-11 we discovered main's actual test262 baseline had drifted to
20,544/43,164 — a ~1,200 test drop from the `test262-current.jsonl` committed
on main (21,750). The PR CI gate had been letting merges through based on a
frozen stale baseline, and regressions accumulated silently over a ~2-hour
window of 12 merged PRs. Individual PR CI deltas claimed +2,778 combined; the
real aggregate was −1,206.

The regression gate was doing exactly the opposite of its job: it was
preventing main from noticing it had regressed.

## Root cause

In `.github/workflows/test262-sharded.yml`, the `merge` job combines two
orthogonal responsibilities:
1. **Build a merged test262 report** from shard artifacts (deterministic,
   should always succeed).
2. **Fail on regressions** relative to `benchmarks/results/test262-current.jsonl`
   (the gate, should only block PRs).

`promote-baseline` (line 198) depends on `needs.merge.result == 'success'`. On
`push` events, if the merged report shows any regressions vs. the currently-
committed baseline, the `Fail on regressions` step exits 1 → `merge` job fails
→ `promote-baseline` is skipped → baseline stays frozen. Every subsequent push
repeats this silently. The baseline never refreshes, so PRs inherit stale-
baseline noise as "not my fault".

Secondary bug: PR CI reads the baseline file as committed at the PR branch tip
(after the dev's `git merge main`). If main's committed baseline is hours
stale, PRs diff against a world that hasn't existed for hours.

## Umbrella scope

Four independent structural fixes, tracked as child issues so they can be
reviewed and dispatched individually:

- **#1076** — Split `merge` job into `merge-report` (always succeeds) +
  `regression-gate` (blocks PRs only). `promote-baseline` depends on
  `merge-report`. Push-to-main becomes self-correcting.
- **#1077** — PR CI fetches fresh baseline from `origin/main` at CI runtime
  instead of reading the branch-point copy. Defense-in-depth for baseline
  staleness between "dev merged main" and "PR CI runs".
- **#1078** — Make the emergency workflow_dispatch `allow_regressions=true`
  path more discoverable and guarantee it always promotes.
- **#1079** — Baseline age stamp + SHA in the committed report, surfaced on
  the landing page. Operational visibility: drift becomes observable before
  crisis.

## Acceptance criteria (umbrella)

- [ ] All four child issues (#1076–#1079) merged.
- [ ] A simulated regression push-to-main (artificial +0 −50 diff) results in:
      (a) merged report generated, (b) baseline refreshed to new numbers,
      (c) regression-gate failing — but only as a signal, not blocking promote.
- [ ] A subsequent PR compares against the new lower baseline and its own
      CI status reflects its real delta vs. current main.
- [ ] Baseline age visible on the landing page; drift > 6h triggers a
      visible warning.

## Risks

- **Regression gate becomes advisory on push**, which is desired — but needs
  paired visibility so humans notice regressions landing on main. #1079
  (landing page age stamp) is the mitigation.
- **Emergency dispatch misuse**: forcing baseline refresh without a real run
  could hide regressions. Limit the emergency path to workflow_dispatch with
  an explicit confirmation input.
- **Incremental rollout**: land #1076 first (core), then #1077/#1078/#1079 in
  any order. Each is independently deployable.

## Relationship

- Parent of #1076, #1077, #1078, #1079.
- Blocks any further merges to main until at least #1076 lands, because
  without it each new PR compounds the drift problem.
