---
id: 1301
sprint: 49
title: "Closure environment field-type mismatch: struct.new[0] expected f64, got anyref"
status: in-progress
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures, arrow-functions
goal: npm-library-support
depends_on: []
related: [1297, 1298, 1300, 1306]
---
# #1301 — Wasm validator rejects closure env: struct.new[0] expected f64, found anyref

## Background

While implementing #1297 (Hono Tier 5 — middleware compose) we hit a
Wasm validation error compiling an array of arrow-function middlewares
that each call a `next()` callback they receive as a parameter:

```
WebAssembly.instantiate(): Compiling function #7:"__closure_4" failed:
struct.new[0] expected type f64, found local.get of type anyref @+1438
```

## Reproduction

```typescript
type Next = () => string;
type Middleware = (c: Context, next: Next) => string;

class Context { path: string; constructor(p: string) { this.path = p; } }

function compose(middlewares: Middleware[]): (c: Context) => string {
  return (c: Context) => {
    let i = 0;
    function next(): string {
      const idx = i;
      i = i + 1;
      if (idx >= middlewares.length) return "end";
      return middlewares[idx](c, next);
    }
    return next();
  };
}

export function test(): string {
  const mws: Middleware[] = [
    (c: Context, next: Next) => "[A]" + next(),
    (c: Context, next: Next) => "[B]" + next(),
  ];
  return compose(mws)(new Context("/x"));
}
```

A *single*-element array with a middleware that does NOT call `next()`
compiles and runs fine. The mismatch only fires when the array has 2+
arrow elements that each call `next()`.

## Hypothesis

`__closure_4` is the closure environment for one of the two arrow
middleware bodies. Field 0 is computed as `f64` but the actual
`local.get` materialized at the `struct.new` site has type `anyref`.
Likely causes:

1. The compiler caches a closure-env shape per `(c, next) => ...` arrow
   syntax once and reuses it for the second arrow without recomputing
   field types — but the two arrows have different inferred capture
   types.
2. A free-variable type inference path defaults to `f64` (numeric) when
   it cannot resolve a capture, then later writes `anyref` when the
   capture turns out to be a function ref.
3. The `next` parameter is mistakenly classified as a captured variable
   (rather than a parameter), getting an env-field slot, and the slot
   type disagrees between the two middleware arrow expressions.

## Investigation pointers

- `src/codegen/expressions.ts` — closure env layout for arrow expressions
- `src/codegen/index.ts` — `__closure_N` struct generation
- The `addUnionImports` shifting note in CLAUDE.md: late index shifts can
  desync closure body offsets from env field types

## Acceptance criteria

1. The two-middleware compose reproduction above compiles cleanly
2. Wasm validator passes for array-of-arrow-middleware patterns
3. Tier 5 #1297 test `5c — compose: two middlewares run in registration
   order` passes without skip marker (currently skipped with TODO #1301)

## Files

- `src/codegen/expressions.ts` — closure env field-type resolution
- `src/codegen/index.ts` — `__closure_N` struct emission

## Why this matters

Middleware-compose is the entire `koa`/`hono` core abstraction. Without
it, the npm library support goal cannot move past simple route trees.

## Findings + fix (2026-05-03)

### Root cause

`compileCallExpression` in `src/codegen/expressions/calls.ts` resolved a
plain identifier callee against `ctx.funcMap` BEFORE checking
`fctx.localMap`. When an arrow function had a parameter named `next` AND
an enclosing scope declared `function next() {...}`, the arrow body's
`next()` resolved to the outer function via funcMap. The
"nested-captures prepend" path then read `cap.outerLocalIdx` indices
that pointed to the outer fctx's locals — but in the lifted arrow's
fctx they map to entirely different (or out-of-range) locals, hence
`local.get 4` of an `anyref __tmp_1` being fed into a `struct.new
__ref_cell_f64` (whose field 0 is `f64`).

### Fix

In `compileCallExpression`'s "Regular function call" branch, when the
callee is a plain identifier, check `fctx.localMap.has(funcName)` first.
If true, the local lexically shadows any outer function or module-level
closure of the same name; skip funcMap and closureMap lookups so the
fallback dispatches via call_ref through the local's funcref. Without
this, arrow params that share names with outer functions silently
break.

### Out of scope (filed as #1306)

End-to-end execution of the two-middleware test (`exports.test() ===
"[A][B]end"`) ALSO requires `mws[idx](c, next)` on a closure-typed
array to dispatch correctly. With #1301's fix applied the binary
validates and instantiates, but `mws[idx](c, next)` compiles to
`ref.null extern; drop` — the call is silently dropped. Tracked under
#1306. Tier 5c "two middlewares" stays skipped pending #1306.

### Test changes

Added `tests/issue-1301.test.ts` with 4 assertions:

1. Two-middleware compose with arrow `next` param shadowing outer fn
   compiles + validates (the literal #1301 bug).
2. Single-mw recursive compose with same shadow pattern compiles +
   validates (regression guard).
3. Non-shadowing case still compiles + executes correctly (no
   regression in the direct-call path).
4. Local shadowing outer fn with same name dispatches via call_ref
   through the local — observable end-to-end (returns 42, not the
   outer fn's 100).

### Acceptance criteria — status

1. The two-middleware compose reproduction compiles cleanly — **DONE**.
2. Wasm validator passes for array-of-arrow-middleware patterns —
   **DONE**.
3. Tier 5 #1297 test 5c passes without skip marker — **DEFERRED to
   #1306**. The validation gap is closed; the runtime gap is a
   separate codegen issue (`mws[idx](c, next)` element-access call on
   closure-typed array drops to `ref.null`).
