---
id: 1335
sprint: 50
title: "spec gap: Object.defineProperty — descriptor attribute fidelity (664 test262 fails, biggest single bucket)"
status: ready
created: 2026-05-08
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: object
goal: spec-completeness
parent: 1328
---
# #1335 — Object.defineProperty: descriptor attribute fidelity

## Problem

`built-ins/Object/defineProperty` test262 bucket is the single largest fail bucket in the
audit: **467 / 1131 pass (41.3%) — 664 fails (600 assertion_fail, 32 other, 16 runtime_error,
7 type_error, 5 wasm_compile)**.

Spec §10.1.6 (OrdinaryDefineOwnProperty) and §20.1.2.4 (Object.defineProperty) require:

1. **Property attributes** (`writable`, `configurable`, `enumerable`) tracked **per property**.
2. **Accessor properties** (`get`/`set`) stored separately from data properties.
3. **Type-checking** the descriptor — non-object descriptors throw TypeError.
4. **Validating** descriptor invariants: a non-configurable property cannot become configurable,
   non-writable cannot become writable, the descriptor type cannot flip from data to accessor, etc.
5. **Coalescing** missing descriptor fields with defaults (writable/configurable/enumerable default
   to false; data-descriptor `value` defaults to undefined).

The current js2wasm implementation in `src/codegen/object-ops.ts` and `src/runtime.ts`:
- Sets the field value but **does not record the attribute flags** for typed structs.
- Only the externref/host path retains attributes (it forwards to host `Object.defineProperty`).
- For typed (struct-backed) objects, redefining a non-configurable property silently succeeds.

## Acceptance criteria

1. `built-ins/Object/defineProperty/15.2.3.6-3-*` (descriptor coalescing) tests pass.
2. `built-ins/Object/defineProperty/15.2.3.6-4-*` (configurable invariants) tests pass.
3. `built-ins/Object/defineProperty/15.2.3.6-5-*` (writable invariants) tests pass.
4. Pass-rate for `built-ins/Object/defineProperty` rises from 41.3% to ≥75%.
5. Object.defineProperties and Object.create(o, descriptors) inherit the fix.

## Files to modify

- `src/codegen/object-ops.ts` — descriptor compilation, attribute storage
- `src/codegen/property-access.ts` — attribute checks on get/set/delete
- `src/runtime.ts` — runtime helpers for typed-object descriptor table

## Implementation Plan

### Root cause

Typed (WasmGC struct) objects have no attribute storage — every property is implicitly
`{writable:true, configurable:true, enumerable:true}`. The descriptor passed to
`Object.defineProperty` is parsed for its `value` but the attribute bits are dropped on the floor.

### Approach

Add a parallel attribute-table struct to typed objects:

```
(type $AttrEntry (struct (field $key (ref string)) (field $flags i32)))
;; flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable, bit 3 = isAccessor
(type $AttrTable (array (mut (ref null $AttrEntry))))
;; Object struct gains an extra (mut (ref null $AttrTable)) — null means "all defaults".
```

When `Object.defineProperty` is called:
1. Parse the descriptor (a JS object) into `(value, flags)` pairs at compile time when possible,
   or at runtime via `__parse_descriptor` host import.
2. Lazily allocate `$AttrTable` on first non-default-attribute write.
3. On subsequent writes, look up by key and validate invariants.

### Edge cases

- Descriptor is null/undefined → TypeError at the call site.
- Descriptor has both `value` and `get` → TypeError (data + accessor mix).
- Descriptor argument is a Proxy → must trap on `[[Get]]` for each known key.
- Property already non-configurable → reject incompatible redefinition (return false in
  Reflect.defineProperty / throw in Object.defineProperty).

### Test262 sample

- `test262/test/built-ins/Object/defineProperty/15.2.3.6-1-1.js` (undefined → TypeError)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-3-1.js` (default attribute coalescing)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-4-82.js` (non-configurable invariants)
