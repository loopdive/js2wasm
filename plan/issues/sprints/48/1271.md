---
id: 1271
title: "for...in / Object.keys enumeration over compiled objects"
status: ready
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
