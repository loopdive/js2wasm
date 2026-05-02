---
id: 671
title: "with statement support"
status: backlog
created: 2026-03-20
updated: 2026-04-28
priority: low
feasibility: medium
goal: spec-completeness
test262_fail: 272
files:
  src/codegen/statements.ts:
    new:
      - "compile with() via dynamic scope chain lookup"
---
# #671 — with statement support

## Status: open

~272 tests use `with(obj) { prop }` which requires dynamic scope lookup.

### Approach
Compile `with(obj) { x }` as: check if obj has property "x" (via hasOwnProperty or struct field check), if so use obj.x, otherwise use the enclosing scope's x. This is a compile-time if/else at each variable reference inside the with block.

For struct-backed objects: emit `struct.get` with field existence check.
For externref objects: emit `__extern_has(obj, "x")` + `__extern_get(obj, "x")`.

## Complexity: M
