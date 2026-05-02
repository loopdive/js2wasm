---
id: 1112
title: "delete operator via undefined sentinel (232 tests)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-03-19
priority: medium
feasibility: medium
task_type: feature
language_feature: delete-operator
goal: property-model
renumbered_from: 124
test262_skip: 232
files:
  src/codegen/expressions.ts:
    new:
      - "compileDeleteExpression — set field to undefined sentinel"
    breaking: []
---
# #1112 — delete operator via undefined sentinel (232 tests)

## Status: open (moved from wont-fix)

Previously labeled "won't implement" — reassessed as achievable.

## Approach

`delete obj.prop` can't remove a WasmGC struct field, but can set it to a sentinel:

1. `delete obj.prop` → `struct.set obj $prop (ref.null)` or undefined sentinel
2. `obj.prop` after delete → returns undefined (check sentinel)
3. `"prop" in obj` → false if sentinel
4. `hasOwnProperty("prop")` → false if sentinel

Works for own properties. Prototype chain deletion not applicable (we don't have dynamic prototype chains).

## Complexity: M
