---
id: 1336
sprint: 50
title: "spec gap: Object.assign drops getters / Symbol keys (27 of 38 test262 fails)"
status: in-progress
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

## Implementation Notes (2026-05-08)

### Scope of this PR — runtime-only host-bridge fixes

Two surface fixes in `_wrapForHost`'s Proxy:

1. **Accessor invocation in `safeGetField`** — when a property is reached
   during host-side `Object.assign`, the Proxy's `get` trap now invokes the
   stored accessor getter (string key: sidecar `__get_<k>`; symbol key:
   `_wasmStructAccessors` map). For Wasm-closure getters the call routes
   through the `__call_fn_0` export so the closure runs inside Wasm, matching
   the existing pattern at line 1094.
2. **Symbol-keyed accessor enumeration in `collectKeys`** — Symbol keys
   defined via `Object.defineProperty(obj, sym, {get/set})` live in
   `_wasmStructAccessors`, not `_wasmStructProps`. The `ownKeys` trap now
   enumerates both maps, and the string-key path strips `__get_<k>` /
   `__set_<k>` accessor sidecar entries (returning the underlying property
   name) so `Object.assign` and spread copy the correct keys.

### Out of scope

The architect's spec calls for a "slow path" in `compileObjectAssign` that
loops with Get/Set per key. That requires:
- Routing `Object.defineProperty(obj, key, {get(){...}})` programmatic calls
  through the same `__defineProperty_accessor` import that object-literal
  accessor declarations use today (currently only literal-form `{get x(){…}}`
  hits `__defineProperty_accessor`; the programmatic form goes via the host
  fallback, which silently misses the getter for opaque WasmGC targets).
- A `compileObjectAssign` codegen-level fast/slow path split with shape
  analysis to gate on accessor-presence.

Both are larger refactors filed against this issue as follow-up work. The
runtime-level proxy fixes here unblock the symbol-key bucket of test262
fails without those compiler changes.

## Test Results

- `tests/issue-1336.test.ts` — 2/2 pass (Symbol-keyed accessor copy + plain
  data property no-regression).
- `tests/equivalence/{object-define-property,object-mutability,sparse-array-spread}.test.ts`
  — 32/32 pass, no regressions.
