---
id: 693
title: "Safe compilation speed optimizations"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-03-20
priority: medium
goal: performance
required_by: [694]
---
# Safe compilation speed optimizations

## Problem
The test262 runner spends significant time generating WAT text output that is
never used (WAT is only useful for debugging).  The preamble string for test
harness helpers is also rebuilt from scratch for every single test, despite
most tests sharing the same small set of helper combinations.

## Changes

### 1. Skip WAT in test262 runner (biggest win ~40%)
Pass `emitWat: false` to both `compile()` call sites in `runTest262File()` and
`handleNegativeTest()`.  The `emitWat` option already existed in
`CompileOptions` -- no new API surface was needed.

### 2. Preamble template cache
Extracted preamble construction into a standalone `buildPreamble()` function.
A module-level `preambleCache` (Map keyed by a bitmask of 17 boolean flags)
stores previously built preamble strings.  Most test262 tests share one of a
handful of distinct helper combinations, so the cache eliminates thousands of
redundant string concatenations.

### 3. Test
Added `tests/emit-wat-option.test.ts` with 4 cases verifying:
- WAT is emitted by default
- WAT is emitted when explicitly requested
- WAT is empty when `emitWat: false`
- Binary output is still valid and executable with `emitWat: false`

## Implementation Summary

**What was done:** Skipped WAT generation in test262 runner, added preamble
template cache.

**Files changed:**
- `tests/test262-runner.ts` -- emitWat: false on compile(), preamble cache +
  buildPreamble() extraction
- `tests/emit-wat-option.test.ts` -- new test file

**What worked:** The `emitWat` option was already wired through the compiler;
only the test262 runner needed updating.

**What didn't:** N/A -- straightforward changes.
