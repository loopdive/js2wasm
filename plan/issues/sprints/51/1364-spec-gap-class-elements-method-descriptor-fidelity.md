---
id: 1364
sprint: 51
title: "spec gap: class elements — method/field descriptor enumerable/configurable/writable (~700 fails)"
status: in-progress
worktree: /workspace/.claude/worktrees/issue-1364-class-element-descriptors
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: spec-completeness
parent: 1334
---
# #1364 — Class element descriptors (verifyProperty fails)

## Problem

`language/{expressions,statements}/class/elements/*` — **700 fails**, dominated by
`assertion_fail`. The standard test pattern is:

```js
class C { static m() {} }
verifyProperty(C, "m", {
  enumerable: false,
  configurable: true,
  writable: true,
});
```

`verifyProperty` (test262 helper) reads
`Object.getOwnPropertyDescriptor(C, "m")` and asserts each attribute. Today our
class methods land on the constructor / prototype as plain key=value, but with
default attribute flags (`{value, writable: true, enumerable: true, configurable: true}`).
Spec §15.7.1.1 says class methods MUST have `enumerable: false`.

Same issue applies to:
- Static methods (`class C { static m() {} }`) — `enumerable: false`.
- Instance methods (`class C { m() {} }`) on prototype — `enumerable: false`.
- Generators / async / async-generators — `enumerable: false`.
- Getters / setters (accessor properties) — separate `[[Get]]/[[Set]]` slot, not data descriptor.
- Static fields — `enumerable: true, configurable: true, writable: true` (different
  from methods!).
- Private fields — not on `[[OwnPropertyKeys]]`; distinct from public.

This is closely tied to #1334 (Object.defineProperty descriptors). #1334 fixes the
storage layer; this issue makes class declaration emit the *correct* attributes
through that storage layer.

Top failing test name patterns: `multiple-` (144), `private-` (97), `after-` (88),
`new-` (66), `same-` (44), `static-` (39), `nested-` (28), `regular-` (22),
`wrapped-` (22), `arrow-` (18) — all in `class/elements/`.

## Acceptance criteria

1. `language/expressions/class/elements/after-same-line-gen-literal-names.js` passes
   (verifyProperty on generator method on prototype, `enumerable: false`).
2. `language/expressions/class/elements/after-same-line-static-gen-literal-names.js`
   passes (static gen).
3. `language/statements/class/elements/regular-definitions-string-property-names.js` passes.
4. `language/statements/class/elements/wrapped-in-sc-array-private-method-call.js` passes.
5. `language/expressions/class/elements/private-static-method-name.js` passes.
6. Pass-rate for `class/elements/` rises from ~30% to ≥75%; **+450 net passes**.

## Files to modify

- `src/codegen/class-bodies.ts` — class method/field/accessor emission.
- `src/runtime.ts` — helpers for class-time descriptor application.
- (Depends on #1334 landing first for the descriptor storage; can co-develop.)

## Implementation Plan

### Root cause

The class-body emitter writes methods/fields onto the constructor or prototype with
direct field-set patterns:

```ts
// Pseudo:
ctorObj["m"] = methodFn;       // sets enumerable=true (default for assignment)
```

instead of:

```ts
Object.defineProperty(ctorObj, "m", {
  value: methodFn,
  writable: true,
  enumerable: false,
  configurable: true,
});
```

For the typed-struct fast path, we don't even have a descriptor table (#1334 work).

### Approach

#### A. Method emission must use defineProperty semantics

In `src/codegen/class-bodies.ts`, for each method declaration (regular, static,
generator, async, async-generator):

- Emit a `__class_define_method(target, name, fn, isStatic)` runtime call.
- Implementation: `Object.defineProperty(target, name, {value: fn, writable: true, enumerable: false, configurable: true})`.
- For accessor methods (get/set), emit `__class_define_accessor(target, name, getter, setter, ...)` which calls `Object.defineProperty` with `{get, set, configurable: true, enumerable: false}`.

#### B. Field emission must use defineProperty semantics

For class fields (instance and static, public — not private):
- Emit `Object.defineProperty(instance, name, {value: initValue, writable: true, enumerable: true, configurable: true})`.
- Note: writable/enumerable/configurable all `true` here (different from methods!).
- Crucially the spec requires `[[DefineOwnProperty]]`, NOT `[[Set]]` — so the field
  is set even if a setter exists on the prototype chain. This is **#1239 territory**;
  cross-link.

#### C. Private field/method handling

Private fields are NOT on `[[OwnPropertyKeys]]` and don't appear in
`Object.getOwnPropertyDescriptors`. They must be stored on a parallel "brand" struct.

Tests for private:
- `Object.prototype.hasOwnProperty.call(c, "#y") === false` (the # is part of the test
  name, not a real property).
- Brand checks (`#x in obj`).

For now: ensure private symbols are stored on a parallel typed struct accessed via
ref-cast on a brand check; this should NOT add public-descriptor entries.

Read `src/codegen/class-bodies.ts` for current private-field emission and verify
no public descriptor table entry is added.

#### D. Static blocks / static initializer

Static initializers (`class C { static { ... } }`) run during class evaluation; they
can call `Object.defineProperty(C, "x", {...})` directly — that should already work
once #1334 lands.

### Edge cases

- Class method with computed name (`class C { [name]() {} }`) — name is evaluated at
  class-declaration time; emit defineProperty with that runtime key.
- Method named `"prototype"` on a static (`static prototype() {}`) — illegal per spec;
  syntax error.
- Method with a getter and a setter in the same class — combined accessor descriptor.
- Static method overriding a name from the parent class — descriptor on subclass C
  shadows.

### Test262 sample

- `test262/test/language/expressions/class/elements/after-same-line-gen-literal-names.js`
- `test262/test/language/expressions/class/elements/after-same-line-static-gen-literal-names.js`
- `test262/test/language/statements/class/elements/regular-definitions-string-property-names.js`
- `test262/test/language/expressions/class/elements/private-static-method-name.js`
- `test262/test/language/statements/class/elements/wrapped-in-sc-array-private-method-call.js`

### Dependencies

- Depends on #1334 (descriptor storage). Can be developed in parallel with mocked
  out runtime, validated against test262 once both land.

### Estimated impact

+450 net passes. §15.7 climbs from 67% to ~74%.

## Slice A — instance methods on C.prototype (this PR)

Per tech-lead's scoping (option 3), implementing only **instance methods on
the prototype** in this slice. Static methods, fields, accessors, generators,
and private members are deferred to subsequent slices (1364b/c/d).

### Implementation

- **`src/runtime.ts`** — added `_prototypeMethodBridges` WeakMap and
  `_getProtoMethodBridge(proto, name)` helper that lazily creates and caches
  a JS function per (proto, methodName). Cached so repeated reads return
  the same reference for `assert.sameValue(c.m, C.prototype.m)`.
- **`src/runtime.ts:__getOwnPropertyDescriptor` host import** — when the
  WasmGC struct receiver is a registered class prototype AND the property
  name is in its `_prototypeMethodNames` allowlist, return a descriptor with
  `value: <bridge>, writable: true, enumerable: false, configurable: true`
  (spec §15.7.1.1).
- **`src/codegen/expressions/calls.ts:Object.getOwnPropertyDescriptor` fast
  path** — when the static struct shape is known and the property name is in
  `ctx.classMethodNames`, fall through to the dynamic host-import path
  instead of returning `ref.null.extern` (the previous "field not found"
  default). This lets the runtime helper handle the proto-method case.

### Out of scope (deferred to follow-up slices)

- Static methods on the constructor `C` (need `__static_method_<C>_<name>`
  exports + post-class defineProperty emission).
- Public field descriptors (different default flags from methods —
  `enumerable: true`).
- Private fields (must NOT add public descriptor entries).
- Getter/setter accessors (separate `__defineProperty_accessor` path).
- Generator/async/async-gen methods (each has different wrapping today).
- Bridge function actually invoking the method via JS-side
  `C.prototype.m.call(c)` — currently the bridge throws TypeError if called.

### Test results

`tests/issue-1364a-class-method-descriptors.test.ts` — 12 cases pass:

- Descriptor object exists (not undefined) for `C.prototype.m`
- `enumerable: false`, `configurable: true`, `writable: true`
- `value` is a function
- Repeated reads return the same function reference (sameValue)
- `hasOwnProperty.call(C.prototype, "m")` === true
- `Object.keys(C.prototype)` is empty (methods non-enumerable)
- Multiple methods each get correct descriptors
- Regression: instance method invocation (`c.m()`) still works
- Regression: instance field descriptor unchanged
- Regression: unknown method returns falsy (pre-existing null/undefined gap)
