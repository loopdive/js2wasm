---
id: 1337
sprint: 50
title: "spec gap: Function.prototype.bind/toString + Function/internals (175 + 7 test262 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: function
goal: spec-completeness
parent: 1328
---
# #1337 — Function objects: bind, toString, length, internals

## Problem

`built-ins/Function`: **207 / 509 (40.7%) — 301 fails** (assertion_fail=122, type_error=65,
runtime_error=43, other=30, wasm_compile=21).

`built-ins/Function/internals`: **1 / 8 (12.5%) — 7 fails**.

Spec §20.2 (Function objects) requires:
1. **`Function.prototype.bind`** (§20.2.3.2): produce a bound function whose
   - `[[BoundTargetFunction]]` is the original
   - `[[BoundThis]]` is set
   - `[[BoundArguments]]` is the partial-application arg list
   - `length` is `max(0, target.length - boundArgs.length)`
   - `name` is `"bound " + target.name`
2. **`Function.prototype.toString`** (§20.2.3.6): return either the source text or a
   `"function name() { [native code] }"` representation for built-ins.
3. **`length`** is the count of formal parameters before the first default-valued or rest param.
4. **`name`** is the binding name (or computed-property name in a class).

Current state:
- `bind` produces a callable, but `length` and `name` aren't recomputed.
- `toString` returns an opaque marker, not the original source — fails any spec test that
  parses the result with `eval`.
- `Function/internals` tests check the [[Call]] / [[Construct]] receiver semantics; we throw
  TypeError on receivers we shouldn't (e.g., calling a bound function with the wrong this).

## Acceptance criteria

1. `built-ins/Function/prototype/bind/length.js` passes.
2. `built-ins/Function/prototype/bind/name.js` passes.
3. `built-ins/Function/prototype/bind/instance-name.js` passes.
4. `built-ins/Function/prototype/toString/built-in-function-object.js` passes.
5. Pass-rate for `built-ins/Function` rises from 40.7% to ≥65%.

## Files to modify

- `src/codegen/closures.ts` — bind closure struct (add length/name fields)
- `src/codegen/index.ts` — function metadata (length, name, source)
- `src/runtime.ts` — `__function_to_string` (returns source or native marker)

## Implementation Plan

### Root cause

`bind` is implemented as a thin externref wrapper that forwards to host `Function.prototype.bind`
when the receiver is externref, and as a closure-allocating Wasm helper for typed functions —
but the typed helper allocates a generic closure struct with no `length` or `name` fields,
so accessing them returns the **target's** values (wrong by spec).

`toString` for compiled-Wasm functions has no source-text reference (the source is parsed and
then discarded). We need to either:
1. Keep the source-text alive in a string table, or
2. Re-emit a synthetic `"function name() { [native code] }"`.

### Approach

1. Extend the bound-function closure struct with `length: i32` and `name: ref string` fields.
   Compute them at the bind callsite when arg count is statically known; otherwise emit an
   inline computation.
2. For `toString`, store a per-function source-text string in a side-table indexed by function
   index. Load it on demand in `__function_to_string`. Fall back to `[native code]` for
   imported/host functions.

### Edge cases

- bind on arrow function (no `this` binding) — bind succeeds; the resulting `this` is ignored.
- bind on a class constructor — must be callable with `new`.
- name on anonymous function (let f = function(){}) is the binding name `"f"`.

### Test262 sample

- `test262/test/built-ins/Function/prototype/bind/length.js`
- `test262/test/built-ins/Function/prototype/toString/built-in-function-object.js`
