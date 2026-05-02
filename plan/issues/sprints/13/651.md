---
id: 651
title: "Empty skip reason for 932 tests"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: contributor-readiness
test262_skip: 932
files:
  tests/test262-runner.ts:
    breaking:
      - "investigate and fix empty-reason skips"
---
# #651 — Empty skip reason for 932 tests

## Status: open

932 tests are skipped with no reason string. This is a bug in the skip logic — tests should always have a reason.

### Fix
Search shouldSkip() for codepaths that return skip:true without setting a reason. Add reasons to all of them.

## Complexity: XS
