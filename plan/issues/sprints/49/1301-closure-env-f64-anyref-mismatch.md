---
id: 1301
sprint: 49
title: "Closure environment field-type mismatch: struct.new[0] expected f64, got anyref"
status: ready
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
related: [1297, 1298, 1300]
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
