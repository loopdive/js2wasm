---
id: 623
title: "Worker timeout: 559 tests killed after 60s"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: easy
goal: generator-model
depends_on: [610]
test262_fail: 559
files:
  scripts/run-test262.ts:
    breaking:
      - "worker timeout too short for complex tests"
---
# #623 — Worker timeout: 559 tests killed after 60s

## Status: review

559 tests fail with "timeout: worker hung > 60s" even after #610 increased timeout to 60s with retry at 120s. These are genuinely slow tests (complex class hierarchies, large generated code).

### Fix
1. Increase default timeout to 90s, retry at 180s
2. Add per-category timeout overrides (class/generator tests need more time)
3. Profile the slowest tests to find compiler performance bottlenecks

## Complexity: S
