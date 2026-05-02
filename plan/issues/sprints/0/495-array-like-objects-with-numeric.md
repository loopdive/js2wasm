---
id: 495
title: "Array-like objects with numeric keys (77 tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: medium
goal: iterator-protocol
depends_on: [488]
test262_skip: 77
files:
  src/codegen/expressions.ts:
    new:
      - "compileArrayLikeObject — object with numeric keys and .length as array"
    breaking: []
---
# #495 — Array-like objects with numeric keys (77 tests)

## Status: open

77 tests use array-like object literals: `{0: 'a', 1: 'b', length: 2}`. These are objects that look like arrays but are plain objects with numeric string keys.

## Approach

Two options:
1. **Compile-time**: if an object literal has only numeric keys and a `length` property, compile it as an array instead of a struct
2. **Runtime**: add numeric property access to structs via a backing array field

Option 1 is simpler and covers the test262 cases. Detect `{0: x, 1: y, ..., length: N}` pattern and emit an array.

## Complexity: S

## Acceptance criteria
- [ ] `{0: 'a', 1: 'b', length: 2}` compiles as an array-like structure
- [ ] `Array.prototype.forEach.call(arrayLike, fn)` works on these objects
