---
id: 343
title: "Narrow prototype chain skip filter in test262 runner"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-03-16
priority: medium
goal: test-infrastructure
---
# Issue #343: Narrow prototype chain skip filter

## Problem

The test262 runner's prototype skip filter (`/\.prototype[\.\s=]/`) was too broad,
skipping ~8395 tests when only ~2255 truly require prototype chain support.

Tests that merely reference prototype methods (like `Array.prototype.indexOf`,
`Number.prototype.toString`, `Object.prototype.toString.call(...)`) were being
unnecessarily skipped.

## Solution

Narrowed the prototype filter to only skip tests that involve prototype chain
**mutation or traversal**:

1. `.prototype = ...` (prototype assignment, excluding `===`/`!==`)
2. `.prototype.xxx = ...` (prototype property assignment, excluding `===`/`!==`)
3. `__proto__` access
4. `Object.getPrototypeOf` / `Object.setPrototypeOf`
5. `.isPrototypeOf`

Read-only prototype method access (e.g., `Array.prototype.indexOf`) is no longer
skipped.

## Impact

- Old skip count: ~8395 tests
- New skip count: ~2255 tests
- Tests unblocked: ~6944 tests

## Files Changed

- `tests/test262-runner.ts` — narrowed prototype skip filter regex

## Implementation Summary

- Replaced single broad regex with 6 targeted patterns
- Used `[^=]` after `=` to avoid false positives with `===`/`!==` comparisons
- Equivalence tests show no regressions (all failures are pre-existing)
