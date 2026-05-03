---
id: 1271
sprint: 47
title: "for...in / Object.keys enumeration over compiled objects"
status: done
created: 2026-05-02
updated: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: for-in, Object.keys, enumeration
goal: npm-library-support
related: [1244]
---

## Implementation note (2026-05-02, dev-1245)

The issue's "throws a compile error or silently skips all keys" claim is
**stale**. Smoke-testing on origin/main shows all four documented
patterns work:

```
for-in over object literal:    OK
for-in over any-typed object:  OK
Object.keys(o).length:          OK
for-in body sees right keys:    OK
```

The compiler already implements the issue's proposed approach:
- `compileForInStatement` (loops.ts:3020) emits `__for_in_keys` /
  `__for_in_len` / `__for_in_get` host imports.
- `emitStructFieldNamesExport` (index.ts:1199) generates a
  `__struct_field_names` Wasm export with comma-separated field names
  per struct type.
- The runtime's `__for_in_keys` (runtime.ts:3100) calls
  `_getStructFieldNames` which dispatches through that export.
- `Object.keys` is compile-time inlined for known struct shapes
  (object-ops.ts:2051).

**Required for it to work**: the JS host must call
`imports.setExports(instance.exports)` after instantiation so the
runtime can dispatch through `__struct_field_names`. This is documented
in the runtime contract (`buildImports.setExports`) but easy to miss.
My initial repro returned 0 because I forgot the `setExports` call;
once added, the for-in returned correct keys.

This PR adds 8 regression tests (`tests/issue-1271.test.ts`):
- for-in over object literal (typed)
- for-in over any-typed object
- Object.keys length
- for-in body sees correct key strings
- for-in over empty object (zero iterations)
- for-in with break (early termination)
- Object.keys returns string array of correct length
- nested object: for-in only iterates top-level keys

Treats #1271 as test-only fix — same approach as #1250, #1275, #1276.

---

# #1271 — `for...in` / `Object.keys` enumeration over compiled objects

## Problem

`for (const key in obj)` and `Object.keys(obj)` do not work on WasmGC struct instances.
Hono Tier 3 uses context spread patterns that iterate over object keys. Currently these
either throw a compile error or silently skip all keys.

## Root cause

WasmGC structs have no runtime key table — field names exist only at compile time. To
support enumeration, the compiler must either:
1. Emit a side-table of field names alongside each struct definition, or
2. Route `for...in` and `Object.keys` through a host import that reflects on the struct layout

## Approach

Emit a parallel string array of field names alongside each struct type. At runtime, when
`for...in` or `Object.keys` is called on a struct-typed value, iterate this name array and
yield/return each key. This is a compile-time cost (larger Wasm binary), not a runtime cost
per se.

For structs that are never enumerated (most structs), the side-table can be elided by a
future optimization pass.

## Acceptance criteria

1. `for (const k in { x: 1, y: 2 }) keys.push(k)` produces `["x", "y"]`
2. `Object.keys({ x: 1, y: 2 })` returns `["x", "y"]`
3. `tests/issue-1271.test.ts` covers both forms
4. No regression in struct tests
