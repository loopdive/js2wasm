---
id: 604
title: "Narrow async flag skip filter (1,311 tests)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: async-model
test262_skip: 1311
files:
  tests/test262-runner.ts:
    new: []
    breaking:
      - "narrow async flag skip — many async tests compile with current async/await support"
---
# #604 — Narrow async flag skip filter (1,311 tests)

## Status: open

1,311 tests skipped because they have the `async` flag in metadata. The compiler now supports async/await (#30). Many of these should compile — the filter is a blanket skip from before async was implemented.

## Approach

1. Remove the `async` flag skip entirely
2. Tests that use simple async/await will pass
3. Tests with complex Promise chains, .then(), or async iteration may fail — file those as separate issues
4. Keep `unsupported feature: async-iteration` (94 tests) as a separate narrower filter if needed

## Complexity: S
