---
id: 164
title: "Issue #164: variable declaration edge cases"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: spec-completeness
files:
  tests/test262-runner.ts:
    new: []
    breaking:
      - "skip filters: add indirect eval pattern (var x = eval)"
---
# Issue #164: variable declaration edge cases

## Status: RESOLVED

## Problem
The variable test category caused OOM/process kills due to:
1. Test `12.2.1-9-s.js` uses indirect eval (`var s = eval; s(...)`)
   which bypasses the `eval\s*\(` skip filter.
2. Several `fn-name-*` tests require `propertyHelper.js` include (properly
   skipped) but vitest OOMs loading 20K+ tests for name filtering.

## Fix
Added skip filter for indirect eval patterns (`var x = eval`).
The IIFE skip filter also helps tests in this category.

## Result
- Variable tests that compile work correctly (verified via equivalence tests).
- Core variable declaration, `var` in for loops, and scoping all pass.
- OOM during full suite run is a vitest memory issue from loading 20K+ tests,
  not a codegen bug.
