---
id: 732
title: "- hasOwnProperty correctness (520 tests)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-03-25
priority: medium
feasibility: medium
goal: property-model
depends_on: [678]
test262_fail: 520
files:
  src/codegen/object-ops.ts:
    modify:
      - "hasOwnProperty/propertyIsEnumerable correctness"
---
# #732 -- hasOwnProperty correctness (520 tests)

## Status: done

## Problem

520 test262 tests check `hasOwnProperty` and fail. The compiler's object model does not correctly distinguish own properties from inherited properties.

### What needs to happen

1. Object struct needs a way to track which properties are "own" (vs. inherited via prototype)
2. `hasOwnProperty(key)` must only return true for own properties
3. `Object.keys()`, `Object.getOwnPropertyNames()`, `for...in` (own check) must respect this
4. Depends on #678 (dynamic prototype chain) for proper inheritance

## Complexity: M (<400 lines)

## Implementation Summary

**Commit**: 832b2ca7 — `fix: improve hasOwnProperty/propertyIsEnumerable correctness (#732)`

**What was done**: Improved hasOwnProperty and propertyIsEnumerable to correctly distinguish own properties from inherited properties in the object model.

**Files changed**: `src/codegen/object-ops.ts` (32 insertions, 1 deletion)
