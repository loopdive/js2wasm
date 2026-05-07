---
id: 1336
sprint: 50
title: "spec gap: Object.assign drops getters / Symbol keys (27 of 38 test262 fails)"
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
# #1336 — Object.assign: getter invocation + Symbol-key copying

## Problem

`built-ins/Object/assign`: **11 / 38 pass (28.9%) — 27 fails (21 assertion_fail, 6 runtime_error)**.

Spec §20.1.2.1 (Object.assign) requires CopyDataProperties to:
1. Enumerate **own enumerable** keys (string + Symbol) of each source.
2. **Invoke getters** on the source — the call must observe the receiver as the source object.
3. **Set** (not DefineOwnProperty) on the target — so target setters and prototype setters are invoked.
4. Skip non-enumerable own keys.
5. Throw if any individual Get/Set throws (and stop the iteration).

The current implementation in `src/codegen/object-ops.ts` (look for `compileObjectAssign`) and the
host fallback `__object_assign` does:
- Iterates only **string** keys (not Symbol keys).
- Reads via direct field access — getters are not invoked on typed structs.
- Writes via direct field assignment — target setters not invoked.

## Acceptance criteria

1. `built-ins/Object/assign/source-own-prop-error.js` passes (getter throw aborts iteration).
2. `built-ins/Object/assign/target-set-symbol.js` passes (Symbol keys copied).
3. `built-ins/Object/assign/Symbol-keys.js` passes.
4. Pass-rate for `built-ins/Object/assign` rises from 29% to ≥75%.

## Files to modify

- `src/codegen/object-ops.ts` — Object.assign emitter
- `src/codegen/property-access.ts` — common get/set with getter/setter invocation
- `src/runtime.ts` — `__object_assign` host fallback (mostly correct already; verify Symbol key handling)

## Implementation Plan

### Root cause

`compileObjectAssign` does a fast loop using `array.copy` on the underlying struct field-list and
skips the per-key Get/Set protocol entirely. This is fine for plain typed structs but wrong when:
- Source has accessor properties.
- Source is a Proxy (must trap).
- Either has Symbol keys.

### Approach

Two-phase:

1. **Fast path** — both source and target are plain typed structs with no accessors and no Symbol
   keys: keep the current `array.copy`-style emit.
2. **Slow path** — fall through to a generic loop:
   ```
   for key in OwnPropertyKeys(source):
     if !desc.enumerable: continue
     v = Get(source, key)   ;; honors accessors
     Set(target, key, v)    ;; honors target setters
   ```
   This must call into the runtime helper since the keys aren't known at compile time.

The key check at the call site: if either source or target is `externref` (or any object whose
type carries an accessor), pick the slow path.

### Edge cases

- Source is null/undefined → ignore (per spec).
- Source has a getter that mutates the source mid-iteration → spec says re-evaluate keys
  is unspecified; we should enumerate once at start.
- Target is frozen → Set throws TypeError at first non-existent property.

### Test262 sample

- `test262/test/built-ins/Object/assign/source-own-prop-error.js`
- `test262/test/built-ins/Object/assign/target-set-symbol.js`
- `test262/test/built-ins/Object/assign/source-own-prop-keys-error.js`
