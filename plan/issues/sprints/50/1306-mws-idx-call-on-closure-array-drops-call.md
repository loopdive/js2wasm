---
id: 1306
sprint: 50
title: "ElementAccessExpression call on closure-typed array drops call: mws[idx](c, next) emits ref.null"
status: in-progress
created: 2026-05-03
updated: 2026-05-07
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures, element-access-call, callable-array
goal: npm-library-support
related: [1301, 1297]
---
# #1306 — `mws[idx](c, next)` on a closure-typed array compiles to `ref.null`, dropping the call

## Background

Surfaced while landing #1301 (closure-env field-type mismatch). With the param
shadowing fix in place, `tests/stress/hono-tier5.test.ts` "Tier 5c — compose:
two middlewares run in registration order" still fails — but for a different
reason than #1301. The compiled binary now validates and instantiates
successfully (the original `struct.new[0]` validation error is gone), but
`exports.test()` returns `null` (or throws) instead of `"[A][B]end"`.

## Reproducer

```typescript
type N = () => string;
type Mw = (c: number, next: N) => string;

function compose(mws: Mw[]): (c: number) => string {
  return (c: number) => {
    let i = 0;
    function next(): string {
      const idx = i;
      i = i + 1;
      if (idx >= mws.length) return "end";
      return mws[idx](c, next);   // <-- compiles to ref.null extern; drop
    }
    return next();
  };
}

export function test(): string {
  return compose([(c, n: N) => "[A]" + n()])(0);  // returns null, expected "[A]end"
}
```

## Root cause (suspected)

Inspecting the WAT for the inner `next` function:

```wat
(func $next ...
  ...
  ;; if (idx >= mws.length) return "end" — emitted correctly
  ;; expected: mws[idx](c, next) call, but actual:
  ref.null extern
  drop
  ref.null extern
  return
)
```

The `mws[idx](c, next)` ElementAccessExpression call resolves to a closure-
typed callable (`Mw = (c, next: N) => string`), but the codegen path for
calling such a value silently emits `ref.null extern` and drops it. Likely
candidates in `src/codegen/expressions/calls.ts`:

- The `ts.isElementAccessExpression(expr.expression)` branch around line 5728
  tries to resolve the element access to a static method name. When the
  receiver is a closure-typed array, `resolvedMethodName` is undefined, and
  control falls through to a path that doesn't dispatch via call_ref.
- The fallback for "element access of unknown method" doesn't synthesize a
  call_ref through the array element when the element type has a TS call
  signature.

## Investigation pointers

- Same file as #1301: `src/codegen/expressions/calls.ts`
- Look at how `obj.method()` resolves callable-typed properties; the array-
  element path likely needs the same treatment with `array[i]` dispatched
  through `__vec_get` + cast + call_ref.
- Note: an inline binding `const mw = mws[idx]; return mw(c, next);` in the
  inner `next` function may work better than the inline `mws[idx](c, next)`
  call. Verify which path the inner function takes (the test source uses the
  inline form).

## Acceptance criteria

1. `mws[idx](c, next)` on a closure-typed array dispatches via call_ref to
   the actual closure stored at index `idx`.
2. Tier 5c "two middlewares run in registration order" test passes
   (`[A][B]end`) without skip marker.
3. Single-mw case with `next()` invocation returns `"[A]end"` (currently
   throws WebAssembly.Exception with #1301 fix applied).

## Files

- `src/codegen/expressions/calls.ts` — element-access call dispatch
- `tests/stress/hono-tier5.test.ts` — un-skip Tier 5c two-mw test after fix

## Why this matters

The middleware-compose pattern is the entire `koa`/`hono` core abstraction.
With #1301 fixed, this is the last gap blocking real array-of-closures
dispatch end-to-end.

## Test Results (2026-05-07, branch `issue-1306-elem-call`)

The dispatch fix landed: `compileCallableElementAccessCall` now handles
`fns[idx](args)` shapes by loading the element through the existing
element-access codegen, unboxing externref → `__fn_wrap_N_struct`, and
emitting `call_ref` against the wrapper's lifted func type.

`tests/issue-1306.test.ts` — 7/7 PASS:
- literal index: `fns[0]("hi")` → `"hi!"`
- const-bound index: `fns[i]("hi")` with `const i = 1` → `"hi?"`
- runtime index: `for (i; i<n; i++) acc += fns[i]("x")` → `"xAxBxC"`
- two-arg call with top-level callable: `mws[0](0, term)` → `"[A]end"`
- runtime index picks the right element: `fns[2]("ok")` → `"third:ok"`
- multi-arg call signature: `ops[i](10, 3)` summed → `50`
- non-callable arrays still compile (`number[].length`) — fallback
  unchanged when callSigs is empty.

**Acceptance #1 — DONE.** Element-access call on a closure-typed array
now dispatches via `call_ref` to the closure stored at `idx`.

**Acceptance #2 / #3 — partially blocked by an orthogonal bug:**
The Tier 5c case `mws[idx](c, next)` and the single-mw `[A]end` case
both expose a separate, pre-existing issue: passing an inner function
declaration that has captures (`next`) as a value FROM INSIDE its own
body compiles to `ref.null.extern`. Verified by running
`compose([(c, n) => "[A]" + n()])(0)` — the dispatch IS now correct,
but `next` is passed as null, so the middleware's `n()` raises
TypeError. Reproduced with the fix reverted (same `THROW`), confirming
the throw is independent of #1306's element-access dispatch.

The smaller repro that isolates the orthogonal bug:

```typescript
function outer(): string {
  let x = "/";
  function next(): string {
    return helper((n) => "[A]" + n(), next, x);
    //                                  ^^^^ compiles to ref.null.extern
  }
  return next();
}
```

The buggy path is in `emitFuncRefAsClosure` (`src/codegen/closures.ts`)
— for unboxed captures it pushes `local.get cap.outerLocalIdx`, where
`outerLocalIdx` is the index in the function's *parent* scope. From
inside `next`'s own body those indices don't apply, but a previous
`localMap.get(cap.name) ?? cap.outerLocalIdx` change (#1177 Stage 1)
caused 100+ test262 regressions in async fns and was reverted (see
the comment at calls.ts:5390-5395). Solving it cleanly likely needs
a narrower lookup that detects "inside-self body" specifically.

Filed as a follow-up: see new issue file (TBD) — Tier 5c remains
skipped until that lands. The #1306 dispatch fix is independently
valuable (3 of 5 acceptance scenarios pass; the npm-library
groundwork is unblocked for top-level callable arrays).

## Files changed

- `src/codegen/expressions/calls-closures.ts` — added
  `compileCallableElementAccessCall` helper (mirrors externref-field
  branch of `compileCallablePropertyCall`).
- `src/codegen/expressions/calls.ts` — wired the helper into the two
  fallback paths inside the `ElementAccessExpression` block (resolved-
  no-method @ ~6371; unresolved-index @ ~6389) and added the import.
- `tests/issue-1306.test.ts` — 7 new tests covering literal/const/
  runtime-index dispatch, multi-arg signatures, and a non-regression
  guard for native primitive arrays.
