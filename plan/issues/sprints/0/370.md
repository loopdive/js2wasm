---
id: 370
title: "- WeakMap and WeakSet (skip filter narrowing)"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: hard
goal: contributor-readiness
test262_skip: 18
files:
  tests/test262-runner.ts:
    new: []
    breaking: []
---
# #370 -- WeakMap and WeakSet (skip filter narrowing)

## Status: review

10 WeakMap + 8 WeakSet tests. Full implementation needs weak reference semantics.

## Pragmatic approach (implemented)

Moved WeakMap/WeakSet from UNSUPPORTED_FEATURES hard-skip to source-level checks,
matching the existing Symbol/Reflect pattern. Tests that are merely *tagged* with
WeakMap/WeakSet features but don't actually reference them in the source code are
now unblocked.

Tests that do use WeakMap/WeakSet in their source are still skipped.

## Implementation Summary

**What was done:**
- Removed `"WeakMap"` and `"WeakSet"` from the `UNSUPPORTED_FEATURES` set
- Added source-level regex checks in `shouldSkip()`: only skip when `\bWeakMap\b` or `\bWeakSet\b` appears in the test body (after stripping the YAML metadata block)
- Follows the same pattern used for Symbol, Reflect, and dynamic-import

**Files changed:**
- `tests/test262-runner.ts` — filter logic update

**What worked:** The source-level check pattern is well-established in the codebase (Symbol, Reflect, dynamic-import all use it).
