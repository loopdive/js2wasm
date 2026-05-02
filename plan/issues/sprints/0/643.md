---
id: 643
title: "Test262 runner should not overwrite report until run completes"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: test-infrastructure
files:
  scripts/run-test262.ts:
    breaking:
      - "write report atomically at end of run, not incrementally"
---
# #643 — Test262 runner should not overwrite report until run completes

## Status: open

The runner overwrites test262-report.json and test262-results.jsonl at the start of a new run. If the run crashes or is in progress, the report shows incomplete/wrong data. The previous run's results are lost.

### Fix
Write to a temp file during the run, then atomically rename to the final path only when the run completes successfully. Keep the previous report intact until then.

## Complexity: S
