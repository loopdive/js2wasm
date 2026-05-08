---
id: 1366a
sprint: 51
title: "spec gap: class extends Error/TypeError/RangeError — builtin subclassing via existing host imports (+40-60 passes)"
status: in-progress
worktree: /workspace/.claude/worktrees/issue-1366a-extends-error
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

## Resolution (smaller scope than original spec)

Implementation took a more conservative path than the spec's "instance
representation becomes externref" approach. The subclass struct stays a
WasmGC struct; we just augment it with an auto-added `message` field and
fix the static instanceof analysis. This unlocks the AC tests without
requiring a representation refactor (which would be a larger blast radius
and is the right fit for `extends Array/Map/Set/Promise` in #1366b/c/d
where the host instance has structural state we can't inline).

### Implementation

1. **`src/codegen/context/types.ts` + `create-context.ts`** — added
   `builtinErrorParentMap: Map<string, string>` to `CodegenContext` to
   track classes with a builtin-error parent.

2. **`src/codegen/class-bodies.ts`** —
   - Defined `BUILTIN_ERROR_PARENTS` (`Error`, `TypeError`, `RangeError`,
     `ReferenceError`, `SyntaxError`, `URIError`, `EvalError`,
     `AggregateError`).
   - Exported `resolveBuiltinErrorAncestor(ctx, className)` that walks
     `classParentMap` to find the closest builtin-error ancestor.
   - Exported `isBuiltinErrorName(name)`.
   - In the heritage-clause loop, when `parentClassName` is in the set,
     populate `ctx.builtinErrorParentMap`.
   - When `parentClassName` is in the set, auto-add a
     `message: externref` field to `ownFields` (unless the user already
     declared/assigned one).
   - In `compileSuperCall`, when the parent is a builtin error and has
     no Wasm struct fields, emit `this.message = arg[0]` (or `arg[1]`
     for AggregateError, which takes `(errors, message)`).

3. **`src/codegen/expressions/identifiers.ts`** — extended
   `tryStaticInstanceOf` (the helper behind `compileHostInstanceOf`'s
   compile-time fast-path) to recognise the builtin-error chain. For a
   user class with an ancestor in `BUILTIN_ERROR_PARENTS`:
   - `instance instanceof <Ancestor>` → `true`
   - `instance instanceof Error` → `true` (every NativeError ⊂ Error)
   - `instance instanceof <OtherBuiltin>` → `false`

### Test Results

`tests/issue-1366a-extends-error.test.ts` — 10 cases covering all 5 ACs
plus regression checks. All pass:

- AC#1 — `new MyError("x") instanceof MyError` → 1 ✓
- AC#2 — `new MyError("x") instanceof Error` → 1 ✓
- AC#3 — `new MyError("hello world").message` → "hello world" ✓
- AC#4 — regression coverage:
  - regular user class is NOT instanceof Error
  - two-level user-class chain still works (instanceof both A and B)
- TypeError, RangeError, EvalError, ReferenceError, SyntaxError, URIError
  subclasses: each `instanceof Self` AND `instanceof Error` ✓
- TypeError subclass NOT `instanceof RangeError` (orthogonal builtins
  stay false) ✓
- Subclass with extra fields preserves them alongside auto-`message` ✓

Local probe of the 7 `language/statements/class/subclass-builtins/subclass-X.js`
test262 files (Error/TypeError/RangeError/EvalError/ReferenceError/SyntaxError/URIError):
all 7 pass with the new code (was: all 7 fail at the
`assert(sub instanceof <Parent>)` step).

### Out of scope (deferred)

- `extends Array / Map / Set / Promise / Function` — instance representation
  needs to be a real host object for these (deferred to #1366b/c/d).
- `Symbol.species` for typed-container methods.
- Throwing a subclass instance and recovering it via `instanceof` in the
  catch — exception integration is broader than this slice.
- `Object.prototype.toString.call(e) === "[object Error]"` — would need
  the externref-backed approach.
