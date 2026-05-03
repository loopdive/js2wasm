---
id: 1300
sprint: 49
title: "Closure capturing outer parameter inside an inline lambda passed as a Next callback null-derefs at call time"
status: done
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures, function-types
goal: npm-library-support
related: [1297]
---
# #1300 — Closure capturing outer param inside Next-callback lambda null-derefs

## Summary

A function-typed parameter passed into another function works correctly.
But if the receiving function passes that parameter into ANOTHER function
that takes a `Next`-typed callback, and that callback is an INLINE lambda
that captures the outer parameter, calling the lambda null-derefs.

## Repro

```typescript
type Next = () => string;
type Mw = (next: Next) => string;

function compose2(a: Mw, b: Mw): string {
  // Inner lambda `() => b(...)` captures outer parameter `b`. The call
  // to `b(...)` inside the lambda null-derefs at runtime.
  return a(() => b(() => "end"));
}

export function test(): string {
  return compose2(
    (next: Next) => "<a>" + next() + "</a>",
    (next: Next) => "<b>" + next() + "</b>",
  );  // expected "<a><b>end</b></a>", crashes with null pointer deref
}
```

Calling a `Next` parameter directly (not capturing it in another inline
lambda) works:

```typescript
function callIt(f: Next): string { return f(); }  // OK
```

Hoisting the inner step to a module-level function also works (same body
but no closure):

```typescript
function endNext(): string { return "end"; }
function step2(): string { return runMw(2, endNext); }
runMw(1, step2);  // OK
```

## Likely cause

Inline lambdas inside a function that need to capture parameters allocate
a closure environment. The capture for function-typed parameters appears
to lose the boxed-fn unwrap step (related to #1298 but distinct — here
the storage is the closure env struct, not a user struct).

## Where to fix

- `src/codegen/expressions/closures.ts` (or wherever closure env
  packing happens for inline lambdas).
- Verify the closure env's storage of function-typed captures uses the
  same unbox-and-call_ref path as #1298 will install for class fields.

## Acceptance criteria

1. The repro returns `"<a><b>end</b></a>"`.
2. The compose pattern documented in `tests/stress/hono-tier5.test.ts`
   middleware section works without hoisting steps to module level.

## Notes

- Tier 5 currently uses module-level step functions
  (`step2`, `step23`, `endNext`) as a workaround. The middleware
  ordering / arity contract is exercised end-to-end via the workaround.
- Likely shares a fix with #1298 (function-typed value storage). May
  collapse into a single fix once the call-site unwrap is generalized.

## Resolution (2026-05-03)

Root cause was NOT in the closure env packing — it was in the dispatch
decision at the inline-arrow's _argument_ site. `isHostCallbackArgument`
in `src/codegen/closures.ts` only recognized user-defined callees by
name lookup in `funcMap`. When the callee is a function-typed parameter
or local (e.g. `compose1(a)` body does `a(() => "end")`, where `a` is a
`Mw` parameter), `funcMap.get("a")` returns undefined, so the predicate
fell through to `return true`. The arrow `() => "end"` was therefore
compiled via `compileArrowAsCallback` (host externref wrapping the wasm
function via `__make_callback`) instead of `compileArrowAsClosure`
(wasm GC closure struct).

When the receiving Mw (the user-passed arrow) then invoked its `next`
parameter, the call site executed the wasm closure-struct path:
`any.convert_extern → ref.test (ref $wrapper) → if-true: cast and
call_ref / if-false: ref.null`. The `__make_callback` externref is NOT
a wasm GC struct, so `ref.test` returned false, the local was set to
null, and the subsequent `struct.get` deref-crashed with "dereferencing
a null pointer". The intermediate `emitNullCheckThrow` had a backup
local sentinel from `emitGuardedRefCast` that suppressed the throw on
"wrong struct type" (correctly, to allow multi-struct dispatch
elsewhere) — but for parameter-callee invocation there was no
multi-struct fallback to fall through into.

**Fix**: extend `isHostCallbackArgument` to consult the TS symbol of the
callee identifier. If any declaration is a `ParameterDeclaration`,
`VariableDeclaration`, `FunctionDeclaration`, `FunctionExpression`, or
`ArrowFunction`, the callee is a user-side callable holding a wasm
closure value — return false so `compileArrowFunction` selects
`compileArrowAsClosure`. The arrow then becomes a wasm GC struct that
the receiver's `ref.cast` and `call_ref` can unwrap.

**Verification**: `tests/issue-1300.test.ts` (8 cases, all passing):
the original 2-level repro returns `"<a><b>end</b></a>"`, the 1-level
collapse returns `"<a>end</a>"`, regression guards cover named-Mw,
inline-Mw-no-call, named-next-cb, direct-call-with-no-wrap, and
variable-bound Mw callee. Closure equivalence tests
(`fn-variable-call`, `array-callback-three-params`,
`illegal-cast-assert-throws`) — 14/14 still pass on the patched
branch. TypeScript check clean.

The Tier 5 hono test workaround (#1297, module-level step functions)
can now collapse to inline arrows; that follow-up belongs in #1297.
