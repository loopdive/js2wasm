---
id: 1366
sprint: 51
title: "spec gap: class subclass + subclass-builtins prototype chain (~154 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: classes
goal: spec-completeness
---
# #1366 — Class subclass and subclass-builtins prototype chain

## Problem

`language/{expressions,statements}/class/subclass/*` — **88 fails**.
`language/{expressions,statements}/class/subclass-builtins/*` — **66 fails**.
Combined ~154.

Spec §15.7 + §10.2.1 + §10.4.x mandates:

1. **`extends BuiltinCtor`** (Array, Map, Set, Error, RegExp, Promise, Function,
   TypedArray, …): `new Sub()` returns an object whose `[[Prototype]]` is
   `Sub.prototype` AND whose internal slots are the builtin's slots.
2. **`super(…)`** in derived constructor must call the parent's
   `[[Construct]]`, threading the `new.target` so the resulting object's
   `[[Prototype]]` is `Sub.prototype` (not `Parent.prototype`).
3. **Static method inheritance**: `Sub.from === Array.from` (per spec, inherited).
4. **`Symbol.species`** for built-in containers (Array, Map, Set, Promise, RegExp,
   ArrayBuffer, TypedArray) — methods that return a "new instance of the same kind"
   (e.g. `Array.prototype.map`) MUST construct via `O.constructor[Symbol.species]`,
   so a `Sub` instance returns `Sub` from `.map(…)`.

Sample failures:

- `subclass/builtin-objects/Array/length-property.js` — Sub of Array has accurate length.
- `subclass/builtin-objects/Promise/then-returns-subclass.js` — `subPromise.then(…)`
  returns a Sub, not Promise.
- `subclass/default-constructor-spread-args-throws.js` — `class D extends C {}` default
  constructor must spread `…args` correctly.
- `subclass-builtins/Error.js` — `new SubError().message` works.

Current state:

- Subclasses of user classes work (#1239 + sprint 50).
- Subclasses of built-ins likely work via host import side-channel for some types
  (Error, Promise) but struct/typed-array internals don't propagate.
- `Symbol.species` not consulted by typed Array methods.
- `super(…)` may bind `[[Prototype]]` to Parent.prototype not Sub.prototype.

## Acceptance criteria

1. `language/expressions/class/subclass/builtin-objects/Array/length-property.js` passes.
2. `language/statements/class/subclass/builtin-objects/Promise/then-returns-subclass.js` passes.
3. `language/expressions/class/subclass/default-constructor-spread-args-throws.js` passes.
4. `language/statements/class/subclass-builtins/Error.js` passes.
5. Pass-rate for `class/subclass/` and `class/subclass-builtins/` rises from ~30% to
   ≥70%; **+100 net passes**.

## Files to modify

- `src/codegen/class-bodies.ts` — derived-constructor emission, super-call binding.
- `src/codegen/array-methods.ts` — already targeted by #1359 species fix.
- `src/runtime.ts` — `__construct_subclass(SubCtor, ParentCtor, args) -> instance` helper.

## Implementation Plan

### Root cause

Today's class emission compiles `class Sub extends Parent {}` to:

```ts
function Sub_ctor(this) {
  // call Parent_ctor with `this`
  Parent_ctor.call(this);
}
Sub_prototype = Object.create(Parent_prototype);
Sub.prototype = Sub_prototype;
```

For built-in parents (Array, Promise, Error, …), `Parent_ctor` is a host function;
`Parent_ctor.call(this)` doesn't initialize the instance's host-side internal slots
correctly. Per spec, `new Sub()` should:

```
1. Let newTarget = Sub.
2. Let O = OrdinaryCreateFromConstructor(newTarget, Parent.[[Prototype]] proto).
3. Run Parent's [[Construct]] threading newTarget=Sub.
4. Return O.
```

Step 3 is what `Reflect.construct(Parent, args, Sub)` does — the third argument is
the key.

### Approach

#### A. Default-constructor lowering

For `class Sub extends Parent {}` with no explicit constructor, emit:

```ts
function Sub_ctor(...args) {
  return Reflect.construct(Parent, args, Sub);
}
```

…or in Wasm terms, a host import call:

```wasm
local.get $args_array       ;; externref tuple of args
global.get $sub_ctor        ;; externref of Sub
global.get $parent_ctor     ;; externref of Parent (or null for user parents)
call $__construct_via_super
```

`__construct_via_super(parent, args, newTarget)` impl:

```ts
return Reflect.construct(parent, args, newTarget);
```

For user-class parents (typed structs), spread args and call Parent's typed
constructor, then set `[[Prototype]]` to newTarget.prototype.

#### B. Explicit `super(...)`

When user code writes `super(a, b, c)`, lower to the same `Reflect.construct` path
with `newTarget = the current Sub class`.

The current emission probably does `parent_ctor.call(this, a, b, c)` which sets
`this`'s prototype to `Parent.prototype` (or doesn't set it, leaving it as
`Sub.prototype` correctly — *but* host-internal slots are missing).

For built-in parents specifically, the `this` value is special: the host returns
a freshly-created built-in instance, and that instance MUST be returned (not the
incoming `this`). Switch from `parent_ctor.call(this, …)` to
`Reflect.construct(parent_ctor, [args], Sub)`.

#### C. Static inheritance

Static methods on Sub: walk up the prototype chain. For built-in parent statics
(`Array.from`), Sub inherits the descriptor; calling `Sub.from(items)` per spec
constructs via `this` — see #1338 (already filed) for that piece.

#### D. `Symbol.species` for typed containers

Cross-link with #1359 (Array.prototype.{slice,concat,…} species). Promise/Map/Set/
RegExp species hooks live in their respective method emitters. Trace:

- `compileMapPrototypeXxx` in object-ops.ts? (likely host-bridged).
- `compilePromiseXxx` (host).
- For now, when Sub extends a built-in container, all method calls go via host;
  `Symbol.species` is honored automatically by the host's spec-conforming impl.

### Edge cases

- `class Sub extends null {}` — legal; `super()` then calls
  `Reflect.construct(null, …)` — TypeError.
- `class Sub extends Map {}` — Sub-instance must be a real Map (host-side).
- `class Sub extends Function {}` — Sub-instance must be callable.
- `new Sub()` where `new.target` is a third class `class T extends Sub {}` — newTarget
  threads through.
- Constructor that returns an object → ignore implicit binding, return that object.

### Test262 sample

- `test262/test/language/expressions/class/subclass/builtin-objects/Array/length-property.js`
- `test262/test/language/statements/class/subclass/builtin-objects/Promise/then-returns-subclass.js`
- `test262/test/language/expressions/class/subclass/default-constructor-spread-args-throws.js`
- `test262/test/language/statements/class/subclass-builtins/Error.js`
- `test262/test/language/statements/class/subclass-builtins/RegExp.js`

### Estimated impact

+100 passes. Unblocks subclass-of-Array test scenarios, which affects #1359 and
related Array work indirectly.
