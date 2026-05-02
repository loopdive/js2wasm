---
id: 1273
title: "instanceof across compilation boundaries"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: instanceof, classes
goal: npm-library-support
related: [1244]
---
# #1273 — `instanceof` across compilation boundaries

## Problem

`c instanceof Context` where `Context` is a class compiled to a WasmGC struct currently
either returns `false` always or throws. Hono uses `instanceof` to check if a value is a
`Context` object at middleware boundaries.

## Root cause

WasmGC struct types have no prototype chain. `instanceof` in JS checks `obj.__proto__`
against `Class.prototype`. Compiled structs don't expose a prototype.

## Approach

For each compiled class, emit a struct type tag — an i32 type ID stored as the first field
of every struct instance. `instanceof T` compiles to: read the tag field, compare against
T's known tag ID. For inheritance, check the full ancestor chain of tag IDs.

This is already done for some internal runtime checks; needs to be exposed to user-level
`instanceof` expressions.

## Acceptance criteria

1. `class Foo {}; const f = new Foo(); f instanceof Foo` → true
2. `class Bar extends Foo {}; new Bar() instanceof Foo` → true (inheritance)
3. `{} instanceof Foo` → false (non-class object)
4. `tests/issue-1273.test.ts` covers all three
5. No regression in class tests
