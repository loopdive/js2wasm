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

## Investigation notes (2026-05-08, dev-1303)

### Current bind dispatch (stub at calls.ts:1004-1022)

`compileCallExpression` already intercepts `<receiver>.bind(args)` when the
receiver has a TS call signature. The stub:

```ts
if (propAccess.name.text === "bind" && !immediateCall) {
  // drop all args
  for (const arg of expr.arguments) {
    const t = compileExpression(ctx, fctx, arg);
    if (t !== null) fctx.body.push({ op: "drop" });
  }
  // compile receiver as externref, return as-is
  const recvType = compileExpression(ctx, fctx, propAccess.expression, { kind: "externref" });
  if (recvType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (recvType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  return { kind: "externref" };
}
```

**Effect**: `fn.bind(thisArg, …args)` evaluates and discards `thisArg`/`…args`,
returns the original `fn` unchanged. Calls on the result work because the
receiver is still callable, but `result.length` and `result.name` are wrong
(they're the target's), and `(new result(...))` won't propagate
`[[BoundThis]]` / `[[BoundArguments]]`.

### What already passes

- `built-ins/Function/prototype/bind/length.js` — `Function.prototype.bind.length === 1`. Tests the BUILT-IN, not bound functions.
- `built-ins/Function/prototype/bind/name.js` — `Function.prototype.bind.name === "bind"`. Tests the BUILT-IN.

### What fails (sample, headline acceptance criteria 3 + 4)

- `bind/instance-name.js` → `assert.sameValue(target.bind().name, 'bound target')`
  — current return is the unbound target, so `.name === "target"`. Returns
  status:fail, error_category:assertion_fail.
- `toString/built-in-function-object.js` → `TypeError (null/undefined access):
  toString of built-in Function object`. The compiled wasm reaches a path
  that calls toString on a wasm-struct without a registered toString.

### Failure-pattern frequency (built-ins/Function, current baseline)

```
122  assertion_fail
 65  type_error
 43  runtime_error
 30  other
 16  null_deref
 12  wasm_compile
  4  range_error
```

Top error messages:

```
 28  "Bind must be called on a function"  (V8's error — wasm-struct passed to host bind)
 19  "Cannot read properties of null (reading 'apply')"
 16  "Cannot read properties of null (reading 'call')"
 30  "Cannot access property on null or undefined"  (mostly L41:3 / L55:3)
  8  "dereferencing a null pointer"
```

The 28 "Bind must be called on a function" failures come from
`Function.prototype.bind.call(wasm_struct)` — V8 sees the wasm-struct as
non-function and rejects. Fixing requires either (a) wrapping the
wasm-struct in a real JS function before bind, or (b) implementing bind
ourselves and returning a wasm closure struct that carries
`[[BoundTargetFunction]]`, `[[BoundThis]]`, `[[BoundArguments]]`, and
exposes the right `length` / `name` to property reads.

### Recommended implementation (revised from original plan)

Two complementary slices, in dispatch order:

**Slice A — wasm-struct-aware bind dispatch (calls.ts:1004)**

Replace the stub with a host-side helper call:

1. Add `__function_bind` host import: takes `(target_extref,
   thisArg_extref, args_array_extref) → bound_extref`.
2. Inside `__function_bind` (runtime.ts):
   - If `target` is a wasm-struct: wrap it via `wrapForHost` (#1308) into a
     JS function, then call `Function.prototype.bind.call(wrapper, thisArg,
     ...args)` — V8 produces a real bound function with correct
     `length` / `name` / `[[Construct]]`. Return the bound JS function as
     externref.
   - Else (already a JS function): `Function.prototype.bind.call(target,
     thisArg, ...args)` — direct path.
3. The codegen at calls.ts:1004 builds an args-array externref (via the
   existing `__create_array` import or inline `array.new_fixed`), pushes
   target + thisArg + args-array, calls `__function_bind`.

This eliminates the 28 "Bind must be called on a function" failures AND
fixes `bind/instance-name.js` because V8's bind sets `name = "bound " +
target.name` automatically — so as long as the target's wrapper has the
right `.name`, the bound function inherits it. (#1308's `wrapForHost`
already preserves the function name from `mod.functions[i].name`.)

**Slice B — toString source-text retention (runtime.ts + index.ts)**

For `toString/built-in-function-object.js`, V8's spec requires
`Function.prototype.toString` to return either the original source text
(for source-defined functions) or a string of the form `"function name() {
[native code] }"` (for built-ins).

1. Compile-time: store the source text of each user-defined function in a
   side table indexed by funcIdx. At codegen time, capture
   `funcDecl.getText()` (or the body range) into
   `ctx.functionSourceText: Map<number, string>`.
2. Emit `mod.imports[].name === "__function_source_text"` host import that
   takes `(funcref) → externref` (the source string).
3. In runtime.ts, implement `__function_to_string`:
   - If the externref wraps a wasm function: look up its funcref in a
     reverse-map (funcref → source text), return that.
   - Else: forward to `Function.prototype.toString.call(target)`.
4. The bound-function path inherits via slice A: V8 itself handles
   `boundFn.toString()`.

### Scope estimate

- Slice A: ~150 LoC (calls.ts dispatch + runtime.ts host helper +
  args-array handling). Unblocks ~30 tests.
- Slice B: ~200 LoC (functionSourceText map, host import wiring,
  reverse-lookup table). Unblocks `toString/*` tests (~40 in the
  bind+toString clusters).

Reaching the 65% acceptance gate (~125 additional passes) likely needs
both slices PLUS the remaining null-deref / type_error cluster
investigation — those are "Cannot read properties of null (reading
'apply'/'call')" patterns where the receiver is a wasm-struct flowing
into an apply / call site that can't dispatch through the normal closure
path. That cluster overlaps with #1311 (Map<string, AsyncHandler>
dispatch) and #1312 (recursive nested fn self-reference, in PR #257
currently), both of which improve closure-chain visibility — landing
those first will reduce the bind / toString work surface.

### Risks

- `wrapForHost` for bind needs all closure-typed values to round-trip
  through V8's bind. If the wrapper drops captures (which would break
  `(boundFn)()` semantics), this slice produces non-functional bound
  functions. Verify via probe before committing to host-bind dispatch.
- Source-text retention adds compile-time bytes (each user-defined
  function holds a string copy). For typical programs this is bounded by
  source size; for generated code it's a non-issue.

### Status

Investigation complete; implementation deferred. The notes above translate
the original plan into concrete code-level steps with line refs. A dev
picking this up next can start with **Slice A** (smaller blast radius,
unlocks the bind cluster on its own).
