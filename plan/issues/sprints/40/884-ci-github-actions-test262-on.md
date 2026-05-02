---
id: 884
title: "CI: GitHub Actions test262 on every PR"
status: done
created: 2026-03-31
updated: 2026-04-09
completed: 2026-04-09
priority: high
feasibility: medium
reasoning_effort: high
goal: ci-hardening
depends_on: [882]
required_by: [1007]
---
# #884 -- CI: GitHub Actions test262 on every PR

## Outcome

This issue is complete. The repo now has automated test262 CI on pull requests
to `main`.

Implemented in
[test262-sharded.yml](../../../.github/workflows/test262-sharded.yml):

- `pull_request` trigger on `main`
- 16 parallel test262 shard jobs
- merged JSONL/report generation
- regression diff against the current `main` baseline
- failure on regressions by default
- explicit manual override only through `workflow_dispatch`
- baseline promotion on successful `main` pushes

## Notes

The final implementation is stronger than the original minimal ask:

- it runs the real sharded test262 path, not just a tiny smoke subset
- it produces merged artifacts and a stable baseline
- it can be made a required status check to block PR merges

## Acceptance criteria

- PRs receive automated test262 validation
- regressions can fail the workflow and block merges via branch protection
- conformance is visible through CI artifacts and promoted baseline data
