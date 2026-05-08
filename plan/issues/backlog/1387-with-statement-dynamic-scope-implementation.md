---
id: 1387
sprint: ~
title: "feat: implement `with` statement — architect exploration of dynamic-scope compilation strategies"
status: ready
created: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, ir
language_feature: with
goal: spec-completeness
---
# #1387 — `with` statement: architect exploration

## Background

`with` is currently in the test262 skip list and emits `CE: Unsupported statement: WithStatement`
(294 tests). The statement has been avoided because it creates dynamic scope — any bare identifier
inside a `with(obj){}` block may refer to a property of `obj`, defeating static type analysis and
WasmGC typed struct emission.

However, the user has asked for an architect exploration: **how can we implement `with` nonetheless?**
If a fully static path is not possible, an IR-dependent or externref-fallback path may be acceptable.

## What `with` does (spec §14.11)

```js
with (expression) statement
```

1. Evaluate `expression` → get object `obj`.
2. Push `obj` onto the lexical environment chain.
3. Execute `statement` with identifier resolution checking `obj`'s properties first.
4. Pop `obj` from the chain.

Key invariant: any read/write of an identifier `x` inside the body must first check
`Object.prototype.hasOwnProperty.call(obj, x)` (or `x in obj`) before falling through to the
outer scope. This means identifier access is **not statically resolvable** inside a `with` body.

## Why this is hard for a WasmGC compiler

Normal compilation assigns each local variable to a typed Wasm local (`local.get $x`). Inside a
`with` body, `x` might be `obj.x` or the local `x` depending on runtime state. A static compiler
must either:

- Compile the entire `with` body in a "slow mode" where every identifier read/write goes through
  a dynamic dispatch, OR
- Refuse to handle the case statically and fall back to an interpreter path.

## Possible approaches for the architect to evaluate

### A — Pure externref slow-path body

Compile the `with` body with all variables accessed via `__extern_get` / `__extern_set` on a
runtime scope chain. The body emits no typed locals for variables that might be shadowed by `obj`.

Requires a runtime scope-chain object: `{ obj, outer }` threaded through the body. Every
identifier read becomes:

```
if (obj hasOwn x) return obj.x
else return outer lookup x
```

Expensive but correct for the common case (`with(document){}`, `with(Math){}`).

**IR connection**: the IR path already emits `externref`-typed code for opaque objects. A `with`
body could be compiled with all ambient variables boxed as `externref`, which the IR integrates
naturally for its existing externref functions.

### B — Static analysis for non-overlapping names

If the body of `with` uses no identifiers that could plausibly be properties of `obj` (e.g., all
local variables in the `with` body are uniquely named and `obj`'s type is known to be a plain
`{}` with no matching keys), fall back to normal compilation. This is a narrower but zero-overhead
fast path.

### C — Desugar to a closure call

Transform:
```js
with (obj) { stmt }
```
into:
```js
(function(__scope__) { with(__scope__) { stmt } }).call(obj);
```
Then compile the inner function body in "dynamic receiver" mode using the IR's existing
`this`-access patterns. Less general but reuses existing infrastructure.

### D — WASI / standalone mode: flat rejection + strict-mode CE

In standalone mode (no JS host), `with` is rejected with a clean compile error explaining
strict mode incompatibility. In JS-host mode, the approaches above apply.

### E — Delegate to JS host for `with` bodies

Emit the `with` body as a JS string template and invoke it via `__eval_with_scope` host import.
Only viable in JS-host mode; defeats standalone goals. Last resort.

## Acceptance criteria for the architect spec

1. Evaluate approaches A–E above (and any others). Identify which are feasible in the current
   architecture and at what cost.
2. For the most viable approach, write a concrete implementation plan:
   - Which files change (`src/codegen/statements.ts` for the `with` emitter, etc.)
   - What new runtime infrastructure is needed (scope-chain struct, imports)
   - How to lift the skip filter in `tests/test262-runner.ts`
3. Estimate test262 yield (currently 294 CE → target: most passing or skip→pass).
4. Flag if the implementation requires IR path dependency and why.

## Related

- `with` skip filter: `tests/test262-runner.ts` (grep `WithStatement` or `with`)
- Eval skip (similar dynamic-scope problem): `plan/issues/wont-fix/1262-eval-static-string-compile-time.md`
- IR externref path: `src/ir/`
- CLAUDE.md architecture principle: "compile away, don't emulate — resolve JS semantics statically"
  — `with` may require a principled exception to this rule for the body scope lookup.
