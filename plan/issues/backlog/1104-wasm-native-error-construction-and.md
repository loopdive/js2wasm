---
id: 1104
title: "Wasm-native Error construction and stack traces without JS host"
status: suspended
created: 2026-04-12
updated: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
language_feature: error-handling
goal: standalone-mode
es_edition: ES5
---
# #1104 — Wasm-native Error construction and stack traces

## Problem

Error, TypeError, RangeError, SyntaxError, URIError, EvalError, ReferenceError, and AggregateError are currently constructed via the JS host's `builtinCtors` table in runtime.ts. This works because JS Error objects carry stack traces that are useful for debugging in a browser/Node environment.

In standalone mode, there is no JS Error constructor. Errors need to be Wasm-native objects.

## Approach

### Error as WasmGC struct

```wasm
(type $Error (struct
  (field $message (ref $String))
  (field $name    (ref $String))
  (field $stack   (ref null $String))  ;; optional, see below
))
```

Each error subclass (TypeError, etc.) is the same struct with a different `$name` field value.

### Stack traces

Options:
1. **No stack traces in standalone mode** — `error.stack` returns `undefined`. Simple, no overhead.
2. **Compile-time stack info** — embed function names and source locations as string constants. When `throw` executes, capture the current call stack via Wasm stack introspection (if the runtime supports it) or a shadow stack.
3. **WASI-specific**: some WASI runtimes expose stack trace APIs — use them where available.

Recommend starting with option 1 (no stack traces) and upgrading to option 2 later.

### try/catch interop

Error objects thrown in Wasm use the exception handling proposal (`throw`, `try`/`catch`/`catch_all`). The thrown value is the Error struct ref. `catch` binds it, `instanceof` checks the struct type.

## Acceptance criteria

- [ ] `new Error("msg")` compiles in standalone mode, produces a struct with `.message === "msg"`
- [ ] `new TypeError("msg")` / `new RangeError("msg")` etc. all compile
- [ ] `error.name` returns the correct error type name
- [ ] `error.message` returns the constructor argument
- [ ] `error instanceof TypeError` works correctly
- [ ] throw/catch with Error subclasses works in standalone mode

## Complexity

M — the struct definition is simple; the work is in wiring up all 7 error subclasses + AggregateError

## Related

- #835 Unknown extern class: Error types (CE in current host mode)
- #1092 Wrong error type (runtime semantics)
- #1325 instanceof built-in type-tag registry (Phase 1 done — registry; Phase 2 = this issue)
- #679 Dual string backend (precedent for the dual-mode pattern)
- #682 RegExp standalone mode native engine (precedent)

## Implementation Plan (added 2026-05-08 by dev-1390-2)

**Status note:** The issue was originally marked `feasibility: medium`. After investigating
the codebase, this is more accurately `feasibility: hard`. The work spans 5+ core codegen
files and requires non-trivial coordination between type registration, import lowering,
property access, instanceof, and exception handling. Recommend either splitting into
explicit phases below, or routing to senior-developer with this plan as the spec.

### Current behaviour (as of commit 1877356d)

- `new Error("msg")` compiles to `call $__new_Error_import` (host import in `env`).
- The import is registered by `collectUnknownConstructorImports` in
  `src/codegen/declarations.ts:1142-1149` for any new-expression whose constructor name
  is not in `KNOWN_CONSTRUCTORS` and not a user class. Error/TypeError etc. are listed in
  `KNOWN_CONSTRUCTORS` (`src/codegen/index.ts:3907`) but still receive `__new_<Name>` host
  imports via the `extern_class` action="new" path through `registerExternClassImports`.
- The runtime in `src/runtime.ts:1637-1701` resolves `__new_Error` via `builtinCtors[Error]`
  — the real JS `Error` constructor.
- Throw/catch uses a single tag `$__exn` with externref payload (see
  `src/codegen/statements/exceptions.ts:199-240`). The payload is whatever JS object the
  expression evaluated to.
- `instanceof Error` falls through `compileHostInstanceOf` to `__instanceof` host import,
  unless statically eliminable via the #1325 registry (`src/codegen/builtin-tags.ts`).

In WASI mode (`--target wasi`), the env import for `__new_Error` is still emitted but
no env module is provided at instantiation → `WebAssembly.instantiate(): Import #0 "env":
module is not an object or function`. **This issue is the gap in standalone mode.**

### Phase 1 — instantiation only (safe, narrow)

Goal: WASI module with `new Error("msg")` instantiates standalone (no env imports for
the 7 error constructors). All field access, instanceof, throw/catch deferred to later
phases.

1. Add WasmGC struct type `$Error_struct` to `src/codegen/index.ts` near the existing
   `$__vec_externref` definitions:
   ```
   (type $Error_struct (sub (struct
     (field $tag (mut i32))                ;; from BUILTIN_TYPE_TAGS (#1325 Phase 2 hook)
     (field $name (ref null extern))       ;; "Error" / "TypeError" / etc.
     (field $message (mut (ref null extern)))
   )))
   ```
2. In `src/codegen/declarations.ts:1142-1149` (`collectUnknownConstructorImports` finalize),
   gate the `addImport(env, __new_<Name>)` behind `!ctx.wasi`. When `ctx.wasi`, instead
   register an internal Wasm function `__new_<Name>` that:
   ```
   (func $__new_<Name> (param $msg externref) (result externref)
     i32.const <BUILTIN_TYPE_TAGS[Name]>
     <push global.get of "Name" string constant>
     local.get $msg
     struct.new $Error_struct
     extern.convert_any
   )
   ```
3. Use `addStringConstantGlobal(ctx, "Error")` etc. so the name string is in the pool
   (works for both nativeStrings and js-host strings).
4. Verify compile + instantiate end-to-end with no env imports needed.

**Files touched:** `src/codegen/index.ts` (struct type), `src/codegen/declarations.ts`
(import → internal func), `src/codegen/builtin-tags.ts` (export the tag values for use).

**Test:** `tests/issue-1104-phase1.test.ts` — compile in WASI mode, instantiate without
env, confirm `new Error("x")` does not crash. **Not** asserting `.message === "x"` —
that's Phase 2.

### Phase 2 — property access (.message, .name)

Goal: `error.message` and `error.name` work in WASI mode.

1. Add a TS-symbol-resolution path in `src/codegen/property-access.ts` so when the LHS
   resolves to type `Error` / `TypeError` / etc. (any builtin error constructor), and we
   are in WASI mode, emit:
   ```
   <push LHS as externref>
   any.convert_extern
   ref.cast (ref $Error_struct)
   struct.get $Error_struct $message  ;; or $name
   ```
2. The result is `(ref null extern)` (matches how strings flow elsewhere).
3. In JS-host mode, keep the existing `__extern_get` path so we don't break runtime tests.

**Files touched:** `src/codegen/property-access.ts`, possibly the IR property-access
lowering (`src/ir/lower.ts`).

**Test:** confirm `.message === "x"` and `.name === "TypeError"` in WASI mode.

### Phase 3 — instanceof + throw/catch

Goal: `error instanceof TypeError` and `try { ... } catch (e) { e instanceof Error }`
work in WASI mode.

1. Use the `$tag` field on `$Error_struct` (populated by Phase 1's struct.new) to drive
   `instanceof` checks. In `compileHostInstanceOf`, when LHS is statically typed as
   `$Error_struct` (or runtime ref.test passes), compare `struct.get $tag` against
   `BUILTIN_TYPE_TAGS[RHS]` and walk `BUILTIN_PARENT` for subclass checks.
2. Throw path is mostly fine — `throw` already coerces the value to externref. We need
   `catch` to handle the case where the bound externref is actually an `extern.convert_any`
   wrapper around an `$Error_struct`. The `instanceof` check in the catch body then walks
   the tag.

**Files touched:** `src/codegen/expressions/identifiers.ts` (compileHostInstanceOf — extend
the static path; #1325 already wires the registry), `src/codegen/statements/exceptions.ts`
(no changes expected — externref payload already routes correctly).

**Test:** instanceof + throw/catch round-trip in WASI mode, plus a regression check that
JS-host throw/catch still works (test262 rerun).

### Phase 4 — stack traces (deferred; option 1 = `undefined`)

Per the issue Approach: in standalone mode, `error.stack` returns `undefined`. This is
the simplest path and matches what some embedded JS runtimes do today. A future PR can
add option 2 (compile-time call-stack info) if needed.

### Risk summary

- Phase 1 is contained but has zero test262 baseline impact (CI runs JS-host mode), so
  the dev-self-merge gate gives no signal — net_per_test will be ~0 plus drift noise.
  Both PRs #310 and #317 already ESCALATED on criterion 2 with similar drift; expect the
  same here. Tech-lead override likely needed.
- Phases 2-3 carry larger risk because property-access and instanceof are hot paths.
  Bugs there could regress hundreds of tests.
- Whoever picks this up should size it as L (large), feasibility hard, multi-PR.

## Suspended Work

**Suspended by:** dev-1390-2 on 2026-05-08
**Worktree:** `/workspace/.claude/worktrees/issue-1104-wasm-native-error` (clean — no
work in progress; only this issue file was edited to add the implementation plan above)
**Branch:** `issue-1104-wasm-native-error`

**Reason:** No architect spec for an explicitly `reasoning_effort: high` issue spanning
5+ core codegen files. Investigation showed `feasibility: medium` is incorrect — actual
feasibility is hard. Two of my prior PRs (#310, #317) already ESCALATED on criterion 2
due to drift, and standalone-mode work has zero test262 baseline impact, so any quality
issues won't surface in CI's gate.

**Resume steps for whoever picks this up:**
1. Read the **Implementation Plan** above — it's complete enough to drive a senior-dev
   implementation, with file references and exact struct shape.
2. Decide whether to land Phase 1 alone first (safe, narrow), or bundle Phases 1-3
   (broader, more invasive, but more useful).
3. The worktree is empty; you can re-cut from `origin/main` or reuse this branch.
4. Strongly recommend invoking `/architect-spec` to refine before coding, since the
   Phase 2 property-access surgery has many edge cases (typed vs untyped LHS, IR vs
   legacy lowering, Object/Function root-class fallback) not fully enumerated above.
