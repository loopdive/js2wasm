---
id: 1300
sprint: 49
title: "Closure capturing outer parameter inside an inline lambda passed as a Next callback null-derefs at call time"
status: in-progress
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

## Implementation

The bug was in `isHostCallbackArgument` in `src/codegen/closures.ts`. The
function decides whether an inline arrow at a call site should be
compiled as a first-class GC-struct closure (`compileArrowAsClosure`)
or as a host-wrapped callback (`compileArrowAsCallback` via
`__make_callback`). It only returned false (= use closure path) when the
callee was a known top-level function in `funcMap`.

When the callee is an identifier that's a *function-typed parameter*
(e.g. `a(callback)` where `a: Mw = (next: Next) => string`), the receiver
(the body of `a`, compiled as `__closure_2`) tries to `ref.cast` the
externref it gets back to a `__fn_wrap_N_struct` and load the `funcref`
field. The host-wrapped externref from `__make_callback` is NOT one of
those wrap structs, so the cast yields null and the next `struct.get`
null-derefs.

Fix: extend the identifier-callee branch to consult the TS checker for
call signatures on the callee's type. If the type has a call signature
(i.e. it's callable — function-typed param, function-typed local, etc.),
take the closure path so the produced externref is shape-compatible with
the receiver's `ref.cast`.

```ts
const calleeType = ctx.checker.getTypeAtLocation(parent.expression);
const callSigs = calleeType?.getCallSignatures?.();
if (callSigs && callSigs.length > 0) return false;
```

Wrapped in try/catch so any TS-checker error falls back to the existing
host-callback path (no behavior change for those cases).

## Test Results

`tests/issue-1300.test.ts` — 4/4 pass:
- two-layer compose: inner lambda captures outer parameter
- single-layer: call function-typed param directly (baseline)
- lambda with no captures passed to a fn-typed param
- three-layer compose: chained captures

Hono Tier 1-5 stress regression: 29/29 active pass (4 unrelated skipped).
Closure / callback / Promise / Map test sweep: identical pass/fail counts
to main (no regressions).
