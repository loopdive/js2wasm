---
id: 1366
sprint: 51
title: "spec gap: class subclass + subclass-builtins prototype chain (~154 fails)"
status: done
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

---

## Implementation Plan (Architect, 2026-05-08)

### Reality check after reading the source

The original "Approach" section above understates the gap. I read:

- `src/codegen/class-bodies.ts:48-655` (`collectClassDeclaration`) — collects
  parent class fields, struct types, and tags. **Has zero special-casing for
  built-in parents.** When `parentClassName` is e.g. `"Error"` /
  `"Array"` / `"Map"`, `ctx.structMap.get(parentClassName)` returns
  `undefined` → `parentStructTypeIdx` stays `undefined` → the *child* is
  treated as a "root" class (gets its own `__tag` field, no super struct
  type). The child fields list contains only what the user wrote in the
  subclass body. There is no way to construct a real `Error` / `Array`
  instance from inside the child constructor.
- `src/codegen/class-bodies.ts:657-951` (`compileClassBodies` constructor
  emission) — emits `struct.new` with default values, then runs field
  initializers and constructor body. `super(args)` is dispatched to
  `compileSuperCall`.
- `src/codegen/class-bodies.ts:1448-1521` (`compileSuperCall`) — for a USER
  parent class, walks the parent's struct fields and assigns each from the
  matched argument with `struct.set`. **For a built-in parent, this is a
  no-op:** `parentFields` is empty (built-ins have no Wasm struct), so the
  loop never runs and the built-in's host-side internal slots
  (`Error.[[ErrorData]]`, `Array.[[ArrayLength]]`, `Map.[[MapData]]`, …) are
  never created. The "instance" remaining in `__self` is just an empty
  WasmGC struct with the child's `__tag` value.
- `src/codegen/typeof-delete.ts:189-475` (`compileInstanceOf`) — the
  WasmGC-struct path: collects the RHS class's tag + descendant tags from
  `ctx.classTagMap`, reads field 0 (`__tag`) from the LHS struct, compares.
  **For `subInstance instanceof Error`**: `Error` is not in
  `ctx.classTagMap` (it's only in `BUILTIN_TYPE_TAGS`), so
  `collectInstanceOfTags` returns `[]` and the function emits `i32.const 0`.
- `src/codegen/expressions/identifiers.ts:603-738`
  (`tryStaticInstanceOf` / `compileHostInstanceOf`) — only fires when the
  LHS is an externref/host value. WasmGC-struct LHSes never reach here;
  they go to `compileInstanceOf` and dead-end at `i32.const 0`.
- `src/codegen/expressions/new-super.ts:1411-1454` — `new Error(msg)` /
  `new TypeError(msg)` etc. already lower to `__new_<Name>(msg)` host
  imports that produce a real JS Error externref. So `Error`-family
  classes ARE a host-import ladder; we just need to plumb that into the
  subclass path.
- `src/codegen/expressions/calls.ts:3040-3057` — `Reflect.construct(C, args)`
  already lowers to `new C(...args)` syntactically, BUT ignores
  `Reflect.construct(C, args, newTarget)`'s third argument. We can extend
  this, but the proper fix lives upstream in `compileSuperCall`.

### Why the original "+100 passes for one PR" estimate is wrong

The full §15.7 surface (built-in subclass + threaded `new.target` +
prototype-chain `instanceof` + `Symbol.species` for Array/Promise/Map/Set/
RegExp/TypedArray) cannot land in one PR without touching every method
emitter in array-methods.ts, object-ops.ts, string-methods.ts, plus the
runtime. **Recommend splitting into 3 child issues** (see "Break-up
recommendation" below). The first child PR alone is realistic and gets
~40-60 of the ~154 fails; the rest follow.

### Break-up recommendation (do this first)

Convert #1366 into a tracking issue and create:

1. **#1366a — `extends BuiltinError` minimum viable** (~40-50 passes,
   1-2 days, low risk).
   Scope: `class Sub extends Error` (and `TypeError`/`RangeError`/…).
   Subclass instances are externref-typed (return type of the constructor
   becomes `externref`, not a WasmGC struct). `super(msg)` lowers to
   `__new_<Parent>(msg)` and the result is the `this` value. No
   `new.target` threading yet — relies on the host runtime setting
   `__proto__` at host-side level (good enough for `Error` family because
   `instanceof Error` and `.message`/`.name`/`.stack` work via the host).

2. **#1366b — `extends Array` / `extends Map` / `extends Set` /
   `extends Promise` via `Reflect.construct` host import** (~30-50 passes,
   2-3 days, medium risk).
   Adds a new `__construct_subclass(parentName: externref, args:
   externref, newTargetProto: externref) -> externref` host import that
   does `Reflect.construct(globalThis[parentName], args, newTarget)` then
   sets `[[Prototype]]` to `newTarget.prototype`. Subclass constructor
   returns the externref.

3. **#1366c — Prototype-chain `instanceof` for hosted subclass instances**
   (~15-30 passes, 1 day, medium risk).
   Extends `compileInstanceOf` (typeof-delete.ts) to detect when LHS is
   externref AND RHS is a built-in (registered in `BUILTIN_TYPE_TAGS`),
   and route to the `__instanceof` host import path that already exists
   for the externref case. Plus the static fast-path for "child class C
   `extends Error`" → `cInstance instanceof Error` is provably true.

4. **#1366d (deferred) — Symbol.species for Array/Promise/Map/Set/RegExp
   methods.** Touches every method emitter; better as its own focused
   sprint after #1359 lands.

The rest of this plan covers child issue **#1366a** in detail (smallest
viable PR). Each subsequent child issue gets its own architect spec when
unblocked.

---

## Implementation Plan: child issue #1366a (extends BuiltinError)

### Root cause for this slice

`class SubError extends Error { ... }` today: `Error` is not in
`ctx.structMap`, so `class-bodies.ts:89` leaves `parentStructTypeIdx`
undefined, the child becomes a "root" struct with no real Error data,
`super(msg)` is a no-op (`compileSuperCall` walks zero parent fields),
and `new SubError("oops").message` returns `undefined` instead of `"oops"`.

### Files to modify

1. `src/codegen/class-bodies.ts` — add built-in-parent detection +
   externref-returning constructor variant + new `compileSuperCallToBuiltin`.
2. `src/codegen/builtin-tags.ts` — add `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`
   set listing the built-ins this PR handles.
3. `src/codegen/typeof-delete.ts` — when the LHS is externref and the
   subclass extends a host-constructible builtin, route `instanceof` of the
   subclass class itself to the `__instanceof` host import (LHS already
   externref).
4. `src/codegen/expressions/new-super.ts` — `compileNewExpression` needs to
   know that `new SubError(args)` returns externref (not a struct ref).

### Step 1 — `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE` registry

**File**: `src/codegen/builtin-tags.ts` (append after line 129)

```ts
/**
 * Built-in constructors for which we emit subclass support via the existing
 * `__new_<Name>(args...) -> externref` host imports. The subclass instance
 * is represented as externref (NOT a WasmGC struct), and the host returns a
 * real JS object with the right internal slots.
 *
 * Scope for #1366a. Array/Map/Set/Promise will follow in #1366b via a
 * generic `__construct_subclass` import.
 */
export const BUILTIN_PARENTS_HOST_CONSTRUCTIBLE: ReadonlySet<BuiltinTypeName> =
  new Set([
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "ReferenceError",
    "AggregateError",
  ]);

export function isHostConstructibleBuiltin(name: string): boolean {
  return (
    isBuiltinTypeName(name) &&
    BUILTIN_PARENTS_HOST_CONSTRUCTIBLE.has(name as BuiltinTypeName)
  );
}
```

### Step 2 — Detect built-in parent in `collectClassDeclaration`

**File**: `src/codegen/class-bodies.ts` line ~78-104 (heritage clause loop).

After resolving `parentClassName`, before the `parentStructTypeIdx` check:

```ts
// (#1366a) Detect built-in parent that is host-constructible.
if (parentClassName && isHostConstructibleBuiltin(parentClassName)) {
  ctx.classBuiltinParentMap ??= new Map<string, string>();
  ctx.classBuiltinParentMap.set(className, parentClassName);
  // Skip parent-struct-type wiring; this subclass does not inherit any
  // WasmGC struct fields from the host parent. Constructor return type
  // becomes externref instead of `(ref $structTypeIdx)`.
  ctx.classExternrefBackedSet ??= new Set<string>();
  ctx.classExternrefBackedSet.add(className);
  // Fall through with parentStructTypeIdx undefined; existing code path
  // already treats it as a root for tag/struct purposes.
}
```

Add the two new context fields to `CodegenContext` in
`src/codegen/context/types.ts`:

```ts
classBuiltinParentMap?: Map<string, string>;     // child -> "Error"|"TypeError"|...
classExternrefBackedSet?: Set<string>;           // child class names whose instance is externref
```

### Step 3 — Constructor return type becomes externref

**File**: `src/codegen/class-bodies.ts` line ~250 and line ~703.

Replace the unconditional `{ kind: "ref", typeIdx: structTypeIdx }`
return type with a check:

```ts
const isExternrefBacked = ctx.classExternrefBackedSet?.has(className) === true;
const ctorResults: ValType[] = isExternrefBacked
  ? [{ kind: "externref" }]
  : [{ kind: "ref", typeIdx: structTypeIdx }];
```

Same change at line ~703 (`returnType: ...`) and line ~719 (`resolvedResults`)
in `compileClassBodies`.

### Step 4 — Constructor body for externref-backed subclass

**File**: `src/codegen/class-bodies.ts` line ~730-944 (constructor body).

When `isExternrefBacked`, do **not** allocate a WasmGC struct
(`struct.new` block at lines 736-760). Instead allocate `__self` as
`externref`, init to `ref.null.extern`, and set it from the result of
`super(args)`. Add early after `params` are bound:

```ts
const isExternrefBacked = ctx.classExternrefBackedSet?.has(className) === true;
const selfLocal = allocLocal(fctx, "__self",
  isExternrefBacked
    ? { kind: "externref" }
    : { kind: "ref", typeIdx: structTypeIdx }
);

if (!isExternrefBacked) {
  // ... existing struct.new + tag init path (unchanged) ...
} else {
  // No struct.new. __self gets set by super(...). Default to null until then.
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.set", index: selfLocal });
}
```

Skip the parent-chain "implicit super()" inline-init block at line 851
when `isExternrefBacked` — there are no fields to copy.

After the constructor body is compiled, the return must be
`local.get $__self` with externref type. The existing
`fctx.body.push({ op: "local.get", index: selfLocal })` at line 944
already does this; the type is selected via `fctx.returnType`.

### Step 5 — `compileSuperCall` host-import branch

**File**: `src/codegen/class-bodies.ts` line ~1448
(`compileSuperCall`).

Add an early branch:

```ts
export function compileSuperCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  childClassName: string,
  selfLocal: number,
  callExpr: ts.CallExpression,
  _allFields: FieldDef[],
): void {
  const builtinParent = ctx.classBuiltinParentMap?.get(childClassName);
  if (builtinParent) {
    // super(msg) for `class C extends Error { ... }` lowers to:
    //   __self = __new_Error(msg)
    // (or __new_TypeError, __new_RangeError, ... — same param shape)
    const args = callExpr.arguments;
    if (args.length >= 1 && !ts.isSpreadElement(args[0]!)) {
      const t = compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
      if (t && t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    } else {
      // 0-arg or spread: push undefined message (refines later in #1366b)
      fctx.body.push({ op: "ref.null.extern" });
    }
    const importName = `__new_${builtinParent}`;
    const funcIdx = ensureLateImport(
      ctx,
      importName,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "local.set", index: selfLocal });
    return;
  }

  // ... existing user-class path (unchanged) ...
}
```

### Step 6 — `new SubError(...)` returns externref

**File**: `src/codegen/expressions/new-super.ts` near line ~2470 (the
generic user-class `new` path that calls `ClassName_new`).

After resolving `funcIdx`, check the constructor's declared result type
(`getFuncResultTypes(ctx, funcIdx)?.[0]`); if it is `externref`, the
expression result type is externref. Most of the path already returns
based on the struct type lookup; we need to short-circuit when the
class name is in `ctx.classExternrefBackedSet`:

```ts
if (ctx.classExternrefBackedSet?.has(ctorName)) {
  // Compile args, call ClassName_new (already returns externref), done.
  // ... compile args identically to the existing user-class path ...
  fctx.body.push({ op: "call", funcIdx });
  return { kind: "externref" };
}
```

### Step 7 — `instanceof` for externref-backed subclass

**File**: `src/codegen/typeof-delete.ts` `compileInstanceOf` (line 254).

When the LHS type is externref and RHS resolves to a class name in
`ctx.classExternrefBackedSet`, OR when the RHS is a built-in name
(`isBuiltinTypeName`), do not run the tag-based path; defer to the
existing `compileHostInstanceOf` in identifiers.ts. Easiest patch:

```ts
export function compileInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType {
  const className = resolveInstanceOfClassName(ctx, expr.right);

  // (#1366a) Externref-backed subclasses (extends Error/TypeError/...) and
  // raw builtin RHS use the host-import path; the WasmGC tag-check would
  // always return 0.
  if (
    className &&
    (ctx.classExternrefBackedSet?.has(className) ||
      isBuiltinTypeName(className))
  ) {
    return compileHostInstanceOf(ctx, fctx, expr);
  }

  // ... existing logic ...
}
```

Also in `tryStaticInstanceOf` (identifiers.ts:616), extend the static
fast-path: if LHS is a user class registered in
`ctx.classExternrefBackedSet` AND its `classBuiltinParentMap[name]` is
`isBuiltinSubtype(parent, ctorName)` — return `true`. This makes
`new MyError() instanceof Error` provable at compile time.

### Wasm IR pattern (constructor of `class MyError extends TypeError`)

```wasm
(func $MyError_new (param $msg externref) (result externref)
  (local $__self externref)
  ;; super(msg)
  local.get $msg
  call $__new_TypeError    ;; -> externref (real JS TypeError instance)
  local.set $__self

  ;; (any user `this.foo = bar` in MyError's ctor would go here, but since
  ;;  __self is externref, those become host property writes via __set_field
  ;;  — already supported for externref `this`)

  local.get $__self
  return
)
```

### Edge cases (still in scope for #1366a)

- `class Sub extends Error {}` with NO explicit constructor → compiler
  emits implicit `super(...args)`. Today, the `if (!ctor)` block at
  class-bodies.ts:851 walks parent struct fields (zero of them for
  Error). For built-in parents, instead emit a `super(args[0])` lowering
  in this branch, picking up the first ctor param. The 0-arg version
  must call `__new_Error(null)`.
- `super()` with no args → push `ref.null.extern` for the message slot.
- `super(...args)` (spread) → for #1366a, defer (host import variant
  doesn't yet accept variadic). Compile the spread, drop, and call the
  zero-arg `__new_Error(null)` — same as 0-arg case but emit a one-off
  `console.warn`-style note in `reportError`. This is acceptable because
  test262 cases of `class X extends Error { constructor(...args){
  super(...args); } }` are rare; rest sprint can refine.
- `class Sub extends Error { constructor(){ super(); this.foo = 1; } }`
  — `this.foo = 1` after `super()` writes a property on the externref
  via the existing externref `this`-property assignment path
  (object-ops.ts handles `this.x = ...` against externref by routing
  through `__set_field`).
- `instanceof` on the externref subclass instance: now resolved by host
  import. `new MyError() instanceof MyError` AND `new MyError()
  instanceof Error` both correctly use `__instanceof(value, name)`.
- Throwing the subclass instance: existing `throw` lowering for
  externref already wraps in the JS-host exception tag; no change needed.

### Edge cases explicitly OUT OF SCOPE for #1366a (move to #1366b/c/d)

- `class Sub extends Array {}` — needs `Reflect.construct(Array, args,
  newTarget)` host import (`#1366b`).
- `class T extends Sub` (3-deep) — newTarget threading; needs
  `__construct_subclass(parent, args, newTarget)` (`#1366b`).
- `class Sub extends null {}` — `super()` must throw TypeError.
  Trivial follow-up; can ride along with #1366b.
- `Symbol.species` honored by `subInstance.map(...)` (`#1366d`).
- Static method inheritance (`SubArray.from`) — already partly tracked
  by #1338.
- `class Sub extends Function {}` — instance must be callable; the
  WasmGC representation makes this hard. Defer to backlog.

### Test262 sample to verify #1366a

Pass these:

- `language/statements/class/subclass-builtins/Error.js` (and -name.js,
  -message.js variants)
- `language/statements/class/subclass-builtins/TypeError.js`,
  `RangeError.js`, `SyntaxError.js`, `URIError.js`,
  `ReferenceError.js`, `EvalError.js`
- `language/expressions/class/subclass/builtin-objects/Error/*` — the
  whole subdir (~15-20 tests).
- `language/expressions/class/subclass/builtin-objects/NativeError/*` —
  another ~20.

### Estimated impact (refined)

- **#1366a alone**: +40-60 passes. Risk: low (constructor return-type
  flip is the riskiest change; isolated to externref-backed classes,
  cannot regress existing user-class paths).
- **#1366b**: +30-50 passes. Risk: medium (new host import, new
  WasmGC↔externref boundary for non-error builtins).
- **#1366c**: +15-30 passes. Risk: low-medium (instanceof routing change
  must not regress the WasmGC tag path).
- **#1366d**: +10-30 passes. Risk: medium-high (touches every species
  emitter in array-methods.ts, object-ops.ts, etc.).

Combined ceiling: ~95-170 passes — consistent with the issue's "+100 net
passes" headline criterion if at least #1366a+#1366b land in the same
sprint.

### Risk register

1. **Return-type flip at constructor boundary**. Existing call sites for
   `new MyClass(...)` assume a `(ref $struct)` is left on the stack. The
   `classExternrefBackedSet` gate prevents this from affecting normal
   user classes, but a missed call site (e.g. method dispatch that
   expects `this: ref $struct`) will throw a Wasm validation error.
   Mitigation: spot-check `compileMethodCall` and `compilePropertyAccess`
   for "if `this` is externref, route through host" branches; these
   already exist for the `Error`/`TypeError` literal-`new` case.
2. **`__new_<Name>` import availability**. Standalone/WASI mode does not
   provide `__new_Error`. Today, `new Error(msg)` falls back to "thrown
   value is just the message string" (new-super.ts:1451). Subclasses
   would inherit that fallback — message-only, no `.name`/`.stack`. Tests
   that explicitly check `.name` against the subclass name will fail in
   WASI. Acceptable; documented limitation.
3. **`compileHostInstanceOf` and string globals**. Routing externref
   instanceof through the host requires a string constant for the RHS
   ctor name. Already handled by `addStringConstantGlobal` —
   no new infrastructure.
4. **`addUnionImports` ordering**. Adding `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`
   does NOT introduce new imports beyond `__new_<Name>` (already existing
   late imports via `ensureLateImport`). No funcIdx-shift hazard.
5. **Ref-typed `super(msg)` argument coercion**. If the user writes
   `super(SomeRefTypedThing)` and the runtime expects an externref
   message, `coerceType` handles it; same as the existing literal-`new
   Error(...)` path.

### Recommended sequencing

Land #1366a first as a standalone PR. After it merges and CI baseline
refreshes, write the spec for #1366b (touches `Reflect.construct` host
import + `compileNewExpression` for `Array`/`Map`/`Set`/`Promise`) — the
ground truth from #1366a's `classExternrefBackedSet` infra carries
forward unchanged. #1366c ships independently of #1366b once at least
one of the two has landed.
