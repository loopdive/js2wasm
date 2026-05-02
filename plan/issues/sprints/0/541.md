---
id: 541
title: "Async flag skip filter blocks 1,311 tests"
status: done
created: 2026-03-18
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
      - "remove/narrow async flag skip — many async tests may compile now"
---
# #541 — Async flag skip filter blocks 1,311 tests

## Status: review

1,311 tests skipped because they have the `async` flag. The compiler now supports async/await (#30), so many of these should compile. The filter is overly conservative.

## Approach

1. Remove the async flag skip
2. Run the tests — some will pass, others will CE/fail on `.then()` chains or Promise patterns
3. File follow-up issues for specific failure patterns

## Complexity: XS

## Implementation Summary

The async flag skip filter had already been removed from `shouldSkip()` in `tests/test262-runner.ts` (the comment at line 118 confirms this). However, 1,311 stale "async flag" skip results persisted in `benchmarks/results/test262-results.jsonl` and were being carried forward indefinitely by the recheck mode in `scripts/run-test262.ts`.

**Root cause**: In recheck mode (the default), both "pass" AND "skip" results were carried forward from previous runs without re-evaluation. This meant that even after a skip filter was removed from the code, the old skip results would persist across all future runs.

**Fix**: Changed recheck mode to only carry forward "pass" results. Skip results are now always re-evaluated using the current `shouldSkip()` logic. This ensures that when a skip filter is removed (as the async flag filter was), those tests are automatically re-run on the next recheck.

### Files changed
- `scripts/run-test262.ts` — recheck mode now only carries forward passes, not skips

### What worked
- Simple, targeted fix that solves the immediate problem and prevents the same class of bug in the future

### What didn't
- N/A
