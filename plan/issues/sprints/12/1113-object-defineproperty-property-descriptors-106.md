---
id: 1113
title: "Object.defineProperty / property descriptors (106 tests)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-03-19
priority: medium
feasibility: medium
task_type: feature
language_feature: property-descriptors
goal: property-model
renumbered_from: 125
required_by: [606, 677, 1114]
test262_skip: 106
files:
  src/codegen/expressions.ts:
    new:
      - "compileDefineProperty — compile-time descriptor resolution"
      - "per-struct descriptor bitfield for writable/configurable/enumerable"
    breaking: []
---
# #1113 — Object.defineProperty / property descriptors (106 tests)

## Status: open (moved from wont-fix)

Previously labeled "won't implement" — reassessed as achievable for common cases.

## Approach

Most uses set simple value/writable/enumerable. Compile-time resolution when descriptor is a literal object:
- `value` → set the field
- `get`/`set` → compile as getter/setter (already supported)
- `writable`/`configurable`/`enumerable` → per-struct descriptor bitfield

`Object.getOwnPropertyDescriptor` reads the bitfield.

## Complexity: M
