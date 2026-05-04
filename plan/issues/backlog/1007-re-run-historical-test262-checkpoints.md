---
id: 1007
title: "Re-run historical test262 checkpoints with the current harness for comparable conformance history"
status: ready
created: 2026-04-09
updated: 2026-04-09
priority: medium
feasibility: medium
task_type: test
language_feature: test262-history-normalization
goal: test-infrastructure
depends_on: [882, 884]
es_edition: multi
---
# #1007 -- Re-run historical test262 checkpoints with the current harness for comparable conformance history

## Problem

The historical conformance timeline is not yet apples-to-apples:

- before **2026-03-18** the project had no meaningful `test262` history
- many late-March runs included **proposal tests** that the current default scope excludes
- newer runs distinguish official/default scope more clearly, but older timeline points still mix scopes

That means the landing-page "ECMAScript Conformance Pass Rate Over Time" graph is useful directionally, but not yet a clean like-for-like history.

## Goal

Re-run historical checkpoints day-by-day with the **current** test setup so the timeline has a normalized comparable series from project start onward.

The checkpoint for each day should be the **last commit of that day**, so the reconstructed history reflects the end-of-day project state rather than an arbitrary intra-day snapshot.

These retrospective runs must:

1. use the current harness and reporting format
2. include **official/default**, **proposal**, and **legacy/sloppy** coverage in the same run
3. record those scopes separately so the graph can choose what to show

## Scope

- choose the **last commit of each day** from project start onward
- run `test262` retrospectively on those commits with the current runner/report format
- store normalized output in a machine-readable history file for dashboard/landing-page consumption
- preserve separate counts for:
  - official/default scope
  - proposal scope
  - legacy/sloppy-only scope
- keep current live baseline generation unchanged

## Deliverables

- a reproducible script/workflow for retrospective checkpoint runs
- normalized history artifacts that include, per checkpoint:
  - commit/date
  - total official tests
  - passed official tests
  - total proposal tests
  - passed proposal tests
  - total legacy/sloppy tests
  - passed legacy/sloppy tests
- landing-page/history consumer can use official-only comparable data without losing the richer scope breakdown

## Acceptance Criteria

- [ ] A reproducible retrospective run procedure exists for historical checkpoints
- [ ] The retrospective checkpoints use the **last commit of each day**
- [ ] The normalized history distinguishes official/default, proposal, and legacy counts explicitly
- [ ] The normalized history covers the project timeline from the start of the repo, including days before the first original `test262` run
- [ ] The resulting data is usable for a like-for-like official-scope graph
- [ ] Proposal and legacy counts remain available for separate overlays, filters, or future charts

## Notes

- This is not just a one-off data backfill. The output format should be stable enough that future rebuilds or corrections can regenerate the same historical series.
- The point is comparability, not preserving old inconsistent measurement conventions.
- Kickoff started on 2026-04-09 against the 2026-02-27 end-of-day commit. The retro runner now overlays the current runtime/test262 harness into historical worktrees and is producing first-run compatibility data.
