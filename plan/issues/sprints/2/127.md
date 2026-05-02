---
id: 127
title: "Issue 127: Private class members (#field, #method)"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: class-system
---
# Issue 127: Private class members (#field, #method)

## Summary

~800 test262 tests use private class fields (`#field`) and methods (`#method`).
Currently all skipped.

## Approach

Private fields are syntactically distinct (`this.#x` vs `this.x`). In wasm,
all struct fields are already private (no JS property access). Implementation:
1. Parse `#field` declarations in class bodies
2. Compile to regular struct fields (already private in wasm)
3. `this.#field` → same as `this.field` in codegen
4. Private methods → regular methods with mangled names

## Complexity

M — Parsing + codegen for # syntax, struct field mapping.
