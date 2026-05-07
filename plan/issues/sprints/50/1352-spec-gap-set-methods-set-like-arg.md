---
id: 1352
sprint: 50
title: "spec gap: Set methods (union/intersection/etc.) accept any set-like argument (101 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: set
goal: spec-completeness
parent: 1328
---
# #1352 — Set new methods: accept any set-like (size + has + keys)

## Problem

`built-ins/Set`: **282 / 383 pass (73.6%) — 101 fails (46 assertion_fail, 39 other, 7 wasm_compile,
7 runtime_error)**.

Spec §24.2.2.x (ES2025 stage 4): the new Set methods must accept any "set-like" object as their
argument — defined as an object with:
- `size` property (number)
- `has(key)` method (returns boolean)
- `keys()` method (returns iterator)

The new methods (union, intersection, difference, symmetricDifference, isSubsetOf, isSupersetOf,
isDisjointFrom) call `GetSetRecord(other)` which does a structural-typing check on the argument.

The 39 'other' errors suggest the methods throw when passed a non-Set with the right shape — e.g.,
a Map (which has `size` and `has` but `keys()` returns key iterator). Spec accepts Maps.

## Acceptance criteria

1. `built-ins/Set/prototype/union/set-like-arg.js` passes.
2. `built-ins/Set/prototype/intersection/setlike-with-non-callable-keys.js` passes.
3. `built-ins/Set/prototype/difference/setlike-with-throwing-has.js` passes.
4. Pass-rate for `built-ins/Set` rises from 74% to ≥90%.

## Files to modify

- `src/runtime.ts` — `__set_union`, `__set_intersection`, etc.
- `src/codegen/registry/set.ts`

## Implementation Plan

### Root cause

Each new Set method currently does an `instanceof Set` check on its argument; spec actually requires
a structural-typing check via `GetSetRecord`:

```javascript
function GetSetRecord(obj) {
  if (typeof obj !== 'object' || obj === null) throw TypeError;
  const rawSize = obj.size;
  const numSize = ToNumber(rawSize);
  if (Number.isNaN(numSize)) throw TypeError;
  const intSize = Math.max(0, Math.trunc(numSize));
  const has = obj.has;
  if (typeof has !== 'function') throw TypeError;
  const keys = obj.keys;
  if (typeof keys !== 'function') throw TypeError;
  return { Set: obj, Size: intSize, Has: has, Keys: keys };
}
```

### Approach

Replace the `instanceof Set` guard with `GetSetRecord` per spec. When the argument size is smaller
than `this.size`, iterate the argument; otherwise iterate `this`. This is also a perf optimization.

### Edge cases

- Argument with `size` returning NaN → TypeError.
- Argument with size = Infinity → use Infinity but iterate `this` (smaller).
- has/keys throw → propagate.

### Test262 sample

- `test262/test/built-ins/Set/prototype/union/set-like-arg.js`
- `test262/test/built-ins/Set/prototype/intersection/setlike-with-non-callable-keys.js`
- `test262/test/built-ins/Set/prototype/difference/setlike-with-throwing-has.js`
