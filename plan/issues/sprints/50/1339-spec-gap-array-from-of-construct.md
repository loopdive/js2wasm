---
id: 1339
sprint: 50
title: "spec gap: Array.from / Array.of constructor semantics (39 test262 fails, wasm_compile dominant)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array
goal: spec-completeness
parent: 1328
---
# #1339 — Array.from / Array.of: subclassing + iterable bridge

## Problem

`built-ins/Array/from`: **18 / 47 pass (38.3%)** — 15 wasm_compile, 9 assertion_fail, 3 other.
`built-ins/Array/of`: **6 / 16 pass (37.5%)** — 8 assertion_fail, 1 type_error, 1 other.

Spec §23.1.2.1 (Array.from) and §23.1.2.3 (Array.of) require:
1. **`Array.from(items, mapFn?, thisArg?)`** — construct via `this` (so `class Sub extends Array`
   produces `Sub.from(...)` returning a `Sub`).
2. From an iterable: GetIterator, loop, push.
3. From an array-like: read .length, iterate by index.
4. **`Array.of(...args)`** — same `this`-as-constructor pattern.

The 15 `wasm_compile` errors strongly suggest the constructor type-check assumes the receiver
is the Array constructor exactly — no support for `Sub.from(...)` where Sub is a subclass.

This relates to issue #1320 (Array.from externref iterator bridge).

## Acceptance criteria

1. `built-ins/Array/from/calling-from-valid-1-noStrict.js` passes.
2. `built-ins/Array/from/iter-set-length.js` passes (set length before assigning elements).
3. `built-ins/Array/of/proto-from-ctor-realm.js` passes.
4. Pass-rate for `built-ins/Array/from` rises from 38% to ≥75%; for `Array/of` from 38% to ≥85%.

## Files to modify

- `src/codegen/array-methods.ts` — `compileArrayFrom`, `compileArrayOf`
- `src/codegen/property-access.ts` — `this`-as-constructor lookup

## Implementation Plan

### Root cause

The Array.from path emits a fixed `array.new` of `(ref Array)` instead of dispatching on the
receiver. When called as `Sub.from(items)`, the receiver is `Sub` — `array.new $Array` is wrong
type, hence `wasm_compile` errors at link time when subclasses use Array.from.

### Approach

When the receiver is statically `Array`, keep the fast path. Otherwise:
1. Resolve receiver at runtime via `__construct_with_this(thisCtor, length)` host import (or
   pure-Wasm helper for typed subclasses).
2. Push elements via `__set_element(target, index, value)` rather than direct
   `array.set $Array.elements`.

For Array.of — same dispatch.

### Edge cases

- Receiver is non-callable → TypeError per spec.
- mapFn returns thenable → spec says no special handling (just store the result).
- iterable returns done=true on first next() → Array of length 0.

### Test262 sample

- `test262/test/built-ins/Array/from/iter-set-length.js`
- `test262/test/built-ins/Array/from/calling-from-valid-1-noStrict.js`
- `test262/test/built-ins/Array/of/proto-from-ctor-realm.js`
