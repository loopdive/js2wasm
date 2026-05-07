---
id: 1337
sprint: 50
title: "spec gap: Object.create(proto, descriptors) ignores descriptor map (162 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen, runtime
language_feature: object
goal: spec-completeness
parent: 1328
---
# #1337 — Object.create: descriptor map handling

## Problem

`built-ins/Object/create`: **158 / 320 pass (49.4%) — 162 fails (131 assertion_fail, 22 other,
5 wasm_compile, 2 illegal_cast, 2 null_deref)**.

Spec §20.1.2.2 (Object.create) requires:
1. Create object with the given prototype (or null).
2. If a second `Properties` argument is provided, call `ObjectDefineProperties(O, Properties)` —
   apply each descriptor to O.
3. Return O.

When called with two args, the descriptor-map handling currently falls through to the same
broken Object.defineProperty path (#1335) — losing all attribute flags.

## Acceptance criteria

1. `built-ins/Object/create/15.2.3.5-4-{1..348}` (descriptor-map application) tests pass.
2. Pass-rate for `built-ins/Object/create` rises from 49.4% to ≥80%.
3. Object.create(null) (null prototype) continues to work.

## Files to modify

- `src/codegen/object-ops.ts` — Object.create emitter
- `src/runtime.ts` — `__object_create` if applicable

## Implementation Plan

### Root cause

Object.create + descriptor map is implemented by lowering to:
1. Allocate object with prototype.
2. For each key in descriptors, call `Object.defineProperty(O, key, descriptors[key])`.

Step 2 inherits the descriptor-attribute fidelity bug from #1335. This issue is fixed
by completing #1335 first — but additional Object.create-specific bugs remain:

- The descriptor map iteration uses `Object.keys` which excludes Symbol keys; spec says
  Object.create must use OwnPropertyKeys (own enumerable) which includes Symbols.
- When prototype is a Proxy, the [[GetPrototypeOf]] trap must be invoked exactly once during
  create — currently invoked twice (assertion_fail).

### Approach

1. Block this issue on #1335 landing.
2. After #1335: verify Object.create-specific tests now pass; if not, fix prototype-trap counting.
3. Use `Reflect.ownKeys(descriptors)` (which returns string + Symbol own keys) instead of
   `Object.keys`.

### Test262 sample

- `test262/test/built-ins/Object/create/15.2.3.5-4-2.js`
- `test262/test/built-ins/Object/create/proto-from-ctor-realm.js`
