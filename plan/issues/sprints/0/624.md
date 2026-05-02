---
id: 624
title: "Wasm struct type errors: struct.new/struct.get mismatches (1,092 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: compilable
test262_ce: 1092
files:
  src/codegen/expressions.ts:
    breaking:
      - "struct.new field count mismatch, struct.get on wrong type"
  src/codegen/index.ts:
    breaking:
      - "struct type registration for class hierarchies"
---
# #624 — Wasm struct type errors: struct.new/struct.get mismatches (1,092 CE)

## Status: open

1,092 tests fail with Wasm validation errors related to struct operations:
- `struct.new` with wrong number of fields
- `struct.get` on a reference that isn't the expected struct type
- Type mismatch between struct field type and value on stack

### Root cause
Class inheritance and struct type registration don't always produce compatible types. When a child class adds fields, the parent struct type doesn't match.

### Fix
Ensure struct type compatibility in class hierarchies. May need struct subtyping or ref.cast before struct operations.

## Complexity: M
