---
id: 1293
sprint: 48
title: "Hono Tier 4 — string[][] array-of-arrays type support + #segments field"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays, typed-arrays
goal: npm-library-support
related: [1285, 1233]
---
# #1293 — Hono Tier 4: string[][] array-of-arrays + #segments field

## Background

Hono Tier 3 (`tests/stress/hono-tier3.test.ts`) fully passes: 11-route TrieRouter
with class-typed Node children, static/parametric/wildcard routing, all correct.

The Tier 2 implementation notes a workaround in the Node class:

```
// `#segments: string[][]`  — path segments per route — also
//    currently blocked by `string[][]` (array-of-arrays) typing
//    in IR; we represent each route's segments as a packed
//    `string` (joined by "") and split at lookup time
```

The real `hono/src/router/trie-router/node.ts` uses `#segments: string[][]`
(each route is a `string[]`, the full table is `string[][]`). The test currently
works around this by packing routes into a single string.

## Goal

Two-part issue:

### Part A — `string[][]` type support

`string[][]` (array of string arrays) requires the compiler to represent a
`(array (ref string))` element type inside an outer array. Currently the IR
and codegen handle `string[]` but not `string[][]`.

1. Write a minimal failing test: `const arr: string[][] = [["a","b"],["c"]]; arr[0][1]`
2. Identify where the type-lowering fails (likely `lowerTypeToIrType` or
   `collectArrayType` in `src/codegen/index.ts`)
3. Fix: nested array types should produce a WasmGC array of array-refs

### Part B — upgrade Hono Tier 4 stress test

Once `string[][]` compiles:
1. Remove the ``-packed workaround from the Node class in the stress test
2. Use real `string[][]` for `#segments`
3. Add a test that reads `node.#segments[0][1]` to verify nested access

## Acceptance criteria

1. `const a: string[][] = [["x"]]; a[0][0]` compiles and returns `"x"`
2. Hono Tier 4 stress test: Node class with real `#segments: string[][]` field
   compiles, instantiates, routes correctly (same 11-route assertions as Tier 3)
3. No regression in Tier 1/2/3 tests

## Files

- `src/codegen/index.ts` — `collectArrayType` / nested array handling
- `tests/issue-1293.test.ts` — unit test for string[][]
- `tests/stress/hono-tier4.test.ts` (new) — Tier 4 stress test

## Notes

- `number[][]` (matrix) should be covered by the same fix
- The fix touches the array type registration path, not the IR selector —
  this is a WasmGC type-section change

## Implementation Notes

The bug was not in `resolveWasmType` / `getOrRegisterArrayType` /
`getOrRegisterVecType` — the IR was already registering nested vec types
correctly. The actual symptom (`WebAssembly.instantiate(): Type index N is
out of bounds @+30`) was a **type-section encoding** issue:

1. `collectClassDeclaration` pre-registers a placeholder struct at
   `mod.types.length` (so self-referencing fields like `next: ListNode | null`
   resolve to a valid type index). The placeholder slot is reserved
   *before* field types are resolved.
2. Resolving a `string[][]` field calls `getOrRegisterVecType` twice —
   once for the inner `string[]` (already cached) and once for the outer
   `string[][]`. The outer registration appends a new array type AND a
   new vec struct *after* the placeholder slot.
3. The placeholder slot is then overwritten with the real class struct
   def, whose `rows` field references the newly-appended vec by its
   actual index — which is *higher* than the class's own index.
4. The emitter encoded each type as its own implicit rec group of 1.
   In WasmGC, a singleton-rec type can only reference earlier types or
   itself. A forward reference (`type idx 3 → type idx 5`) fails
   validation.

Fix: in `src/emit/binary.ts`, automatically detect forward references in
the type section and group consecutive types into a single WasmGC rec
group when needed. `computeRecGroups` walks `mod.types` and extends the
current group's end whenever an entry references a later index;
transitively, the group extends to cover all reachable forward refs.
Singleton groups (no forward refs) are still encoded without a rec
wrapper, preserving canonical type identity for the common case.

This is a backend-only change. No codegen / IR changes required.

## Test Results

`tests/issue-1293.test.ts` (6/6) — minimal repros for `string[][]`,
`number[][]`, class field with `string[][]`, length checks.

`tests/stress/hono-tier4.test.ts` (5/5) — Tier 4 trie-router with
`segments: string[][]` field on Node:
- Tier 4a: `root.segments.length` tracks all 11 registered routes
- Tier 4b: per-route inner length matches `split(path)`
- Tier 4c: nested `node.segments[i][j]` returns the registered segment
- Tier 4d: 11 routes + 3 misses still resolve (regression check vs Tier 3)
- Tier 4e: parametric + wildcard routing unaffected by the new field

Tier 1 / 2 / 3 stress tests (3 + 5 + 6) — all green; no regressions.
