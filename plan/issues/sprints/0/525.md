---
id: 525
title: "RuntimeError: illegal cast (683 FAIL)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: hard
goal: crash-free
test262_fail: 683
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "type coercion — fix struct ref cast failures at runtime"
---
# #525 — RuntimeError: illegal cast (683 FAIL)

## Status: open

683 tests fail at runtime with "illegal cast" — the Wasm `ref.cast` instruction fails because the actual struct type doesn't match the expected type.

## Categories
- `language/expressions/object` (127)
- `language/statements/class` (91)
- `language/expressions/async-generator` (68)
- `language/expressions/class` (62)
- `language/expressions/compound-assignment` (46)
- `language/expressions/generators` (43)

Root cause: the compiler emits `ref.cast` assuming a specific struct type, but the runtime value is a different type (e.g., casting an object literal to a class struct, or a generator wrapper to a plain function).

## Complexity: L

Note: #512 may cover this same pattern — check if it's a duplicate and merge.
