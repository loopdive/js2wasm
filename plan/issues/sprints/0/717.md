---
id: 717
title: "Regression: import.source/defer stub breaks 117 negative parse tests"
status: done
created: 2026-03-21
updated: 2026-04-14
completed: 2026-03-21
priority: high
goal: test-infrastructure
---
# Regression: import.source/defer stub breaks 117 negative parse tests

## Problem

Issue #712 added a catch-all MetaProperty handler for `import.source`/`import.defer` that emits `ref.null.extern`. This makes 117 negative syntax tests pass compilation when they should fail -- the tests expect a parse error but our compiler now silently accepts the syntax.

## Root Cause

The `source-phase-imports` and `import-defer` features were already in `UNSUPPORTED_FEATURES`, but that set is only checked after the `SKIP_DISABLED` early return (line 135). Since `SKIP_DISABLED = true`, the feature check is never reached.

## Fix

Added an unconditional feature skip for `source-phase-imports` and `import-defer` before the `SKIP_DISABLED` guard, matching the pattern used for FIXTURE files and HANGING_TESTS.

## Implementation Summary

- **What was done**: Added `UNCONDITIONAL_SKIP_FEATURES` set containing `source-phase-imports` and `import-defer`, checked before the `SKIP_DISABLED` early return in `shouldSkip()`.
- **Files changed**: `tests/test262-runner.ts`
- **What worked**: Simple feature-based skip filter in the unconditional section of `shouldSkip()`.
