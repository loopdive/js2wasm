---
id: 1366a
sprint: 51
title: "spec gap: class extends Error/TypeError/RangeError — builtin subclassing via existing host imports (+40-60 passes)"
status: ready
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: spec-completeness
parent_issue: 1366
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
