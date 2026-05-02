---
id: 1077
title: "CI: PR CI should fetch fresh baseline from origin/main at runtime, not read branch-tip copy"
status: done
created: 2026-04-11
updated: 2026-04-24
completed: 2026-04-28
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
goal: ci-hardening
parent: 1080
depends_on: [1076]
pr: 14
net_improvement: 0
---
# #1077 — PR CI fetches fresh baseline at runtime

## Problem

In `.github/workflows/test262-sharded.yml`, the `regression-gate` job read
`benchmarks/results/test262-current.jsonl` from the PR branch tip — a stale
copy from whenever the dev last merged main. Caused false regressions and
misattributed improvements on every PR.

## Implementation

Added to `regression-gate` job in `.github/workflows/test262-sharded.yml`
(PR #14, 2026-04-24):

```yaml
- name: Fetch fresh baseline from origin/main
  if: github.event_name == 'pull_request'
  run: |
    git fetch origin main --depth=1
    git show origin/main:benchmarks/results/test262-current.jsonl \
      > benchmarks/results/test262-current.jsonl
```

Step only runs on `pull_request` events. Push-to-main runs unaffected
(they already use the canonical on-branch baseline).

## Acceptance criteria

- [x] PR CI diffs against `origin/main`'s current committed baseline
- [x] Fetch step adds < 5s to CI wall time
- [x] Push-to-main runs unaffected
- [x] Step fails loudly if baseline file missing on origin/main
