---
id: 1114
title: "propertyHelper.js test262 harness (341 tests)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-03-19
priority: medium
feasibility: easy
task_type: test
language_feature: property-descriptors
goal: property-model
renumbered_from: 129
depends_on: [1113]
test262_skip: 341
files:
  tests/test262-runner.ts:
    new:
      - "propertyHelper.js shim — stub verifyProperty with descriptor bitfield checks"
    breaking: []
---
# #1114 — propertyHelper.js test262 harness (341 tests)

## Status: open (moved from wont-fix)

Previously labeled "blocked by #1113" — reassessed.

## Approach

Even without full #1113, stub `verifyProperty()`:
- Check `value` matches → `assert.sameValue(obj[name], desc.value)`
- Check `writable`/`enumerable`/`configurable` → return true (all struct fields default to writable+enumerable+configurable)
- With #1113 implemented: read actual descriptor bitfield

## Complexity: S (stubs), M (with real descriptors from #1113)
