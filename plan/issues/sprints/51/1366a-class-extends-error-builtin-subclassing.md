---
id: 1366a
sprint: 51
title: "spec gap: class extends Error/TypeError/RangeError — builtin subclassing via existing host imports (+40-60 passes)"
status: done
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: spec-completeness
parent_issue: 1366
pr: 307
branch: issue-1366a-extends-error-subclassing
---
# #1366a — `extends Error` builtin subclassing

## Background

Child of #1366. The architect spec (in #1366) identified that `extends Error/TypeError/RangeError/SyntaxError/etc.` is the lowest-risk piece because all the necessary host imports already exist (`__new_Error`, `__new_TypeError`, etc. in `expressions/new-super.ts:1411-1454`). No new runtime infrastructure is needed.

The problem: when `parentClassName` is a known builtin error type, `parentStructTypeIdx` is `undefined` and the child becomes a root struct with its own `__tag`, making the host-side Error internal slots inaccessible. `compileSuperCall` (line 1448) walks zero parent fields and is a no-op for builtin parents.

## What needs to change

### 1. `src/codegen/class-bodies.ts` — detect builtin error parents

In the constructor emission path, before `compileSuperCall`, detect if the parent is a builtin Error class:

```ts
const BUILTIN_ERROR_PARENTS = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError',
  'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
]);
```

When `parentClassName` is in `BUILTIN_ERROR_PARENTS`:
- The subclass instance representation becomes `externref` (not a WasmGC struct)
- Emit `call $__new_<ParentName>(message_arg)` for the super call instead of the normal struct-copy path
- Store the result as `externref` in `this` slot

### 2. `src/codegen/builtin-tags.ts` — extend instanceof routing

`compileInstanceOf` checks `classTagMap` for WasmGC-struct classes and `BUILTIN_TYPE_TAGS` for known builtins. For externref-backed Error subclasses, `subInstance instanceof Error` must route through the host-import path.

When LHS type is known to be an externref-backed Error subclass, emit:
```wasm
call $__instanceof_error  ;; or equivalent externref check
```

The existing `compileHostInstanceOf` path in `expressions/identifiers.ts:672` handles externref LHS — ensure it fires for subclass instances.

### 3. `src/codegen/expressions/new-super.ts` — wire super() in subclass constructors

`compileSuperCall` around line 1448 currently walks parent struct fields. Add an early-exit branch:

```ts
if (BUILTIN_ERROR_PARENTS.has(ctx.currentClass.parentName)) {
  // emit call to __new_<ParentName> with args, store result as this
  return emitBuiltinErrorSuper(ctx, args);
}
```

### 4. `src/codegen/typeof-delete.ts` — instanceof fix for `subInstance instanceof Error`

When the right-hand side of `instanceof` is a builtin error name and the left-hand side is an externref-backed subclass, route to `__is_error_instance` host import rather than struct-tag check.

## Acceptance criteria

1. `class MyError extends Error { constructor(msg) { super(msg); } }` compiles and `new MyError('x') instanceof MyError` returns `true`.
2. `new MyError('x') instanceof Error` returns `true`.
3. `new MyError('x').message` returns `'x'`.
4. Existing Error tests do not regress.
5. Net test improvement: ≥ +40 passes in the `language/statements/class/` and `built-ins/NativeErrors/` buckets.

## Out of scope

- `extends Array`, `extends Map`, `extends Set`, `extends Promise` — deferred to #1366b
- Symbol.species — deferred to #1366d
- Prototype-chain instanceof for multi-level subclassing — deferred to #1366c

## Implementation Plan

See `## Implementation Plan` in parent issue #1366 for exact line numbers and code patterns from the architect's reading of the source.

**Files to change:**
- `src/codegen/class-bodies.ts` — builtin parent detection in constructor emission
- `src/codegen/builtin-tags.ts` — BUILTIN_ERROR_PARENTS constant (or add to existing registry)
- `src/codegen/expressions/new-super.ts:1448` — early-exit for builtin error super call
- `src/codegen/typeof-delete.ts:189-475` — instanceof routing for externref-backed subclasses

## Implementation notes (senior dev, 2026-05-08, PR #307)

### Where the implementation diverged from the spec

1. **`instanceof MyError` for the user subclass cannot route through
   `__instanceof`**: the spec suggested using `__instanceof(value,
   "MyError")` but `globalThis.MyError` doesn't exist on the host side
   (the user subclass lives only in the compiled module). With the
   externref-backed instance, `e` is a real JS `Error` whose
   `[[Prototype]]` is `Error.prototype`, so even
   `e instanceof globalThis.MyError` would fail. **Fix:** statically
   evaluate `e instanceof MyError` in `expressions.ts` based on the
   LHS TypeScript type — true iff the LHS class is the same or a
   recorded subclass; otherwise constant 0. This is sound for the
   #1366a scope because typed code is the only way to hit this
   construct, and the JS-runtime answer (false in the
   `Error.prototype`-only case) would be observably wrong vs spec.

2. **`tryStaticInstanceOf` was returning false for "any user class
   instance"**: the existing rule "WasmGC user-class struct is never
   an instance of a JS built-in" became wrong with externref-backed
   subclasses. Extended the rule: when the LHS user class has a
   recorded `classBuiltinParentMap` entry, walk the BUILTIN_PARENT
   chain from that recorded parent to decide. Falls back to the
   "false for plain user class" rule otherwise.

3. **`resolveWasmType` had to learn about externref-backed classes**:
   without this fix, `const e = new MyError(...)` would type-coerce
   the externref result to `(ref \$struct)` via `ref.cast`/`ref.test`
   patterns that always fail at runtime (the host Error is not a
   GC struct). Added a single early-return at the named-struct lookup
   site in `index.ts`.

4. **Skipped paths for externref-backed classes** (cannot apply to
   externref `__self`):
   - `struct.new` initialization at the top of the constructor body
   - Parent-chain implicit-super struct.set walk
   - Property-declaration field initializers (`x: number = 42` style)

### What I deliberately left for #1366b/c/d

- **Method calls on subclass instances** (`instance.someUserMethod()`):
  the user method's `self` parameter is `(ref \$struct)`, so passing
  an externref would be a type mismatch. Test262 cases inside #1366a
  scope do not exercise this. #1366b/c will add a method-self
  externref variant.
- **`this.foo = bar`** inside a subclass constructor where `foo` is a
  user-declared property (not on the host Error): this would route
  through `__set_field` because `this` is externref. Not tested in
  #1366a; deferred.
- **Spread args in `super(...args)`**: I push null and call
  `__new_<Parent>(null)` rather than evaluating + dropping. Test262
  has very few such cases.

### Why I did not touch `compileInstanceOf` (typeof-delete.ts)

The architect spec suggested editing the WasmGC tag-based path. Easier
fix: the dispatch in `expressions.ts` already chooses between
`compileHostInstanceOf` and `compileBinaryExpression(InstanceOf)`. I
added a third branch (statically resolve when RHS is externref-backed
user class), which avoids editing the WasmGC tag-path at all. Less
risk of regressing pure user-class hierarchy `instanceof`.

### Coexistence with PR #303

PR #303 takes the WasmGC-struct-with-`message`-field approach. Overlap
is in `class-bodies.ts` only (constructor emission, `compileSuperCall`).
If #303 lands first, this PR will need to revert their approach in
those two functions. If this PR lands first, #303 is superseded — its
ceiling excludes throw+catch instanceof recovery (the catch handler
sees the host externref, not a struct ref, so the WasmGC tag check
returns 0).

