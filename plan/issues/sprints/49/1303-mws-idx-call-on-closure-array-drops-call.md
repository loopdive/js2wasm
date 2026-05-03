---
id: 1303
sprint: 49
title: "ElementAccessExpression call on closure-typed array drops call: mws[idx](c, next) emits ref.null"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: closures, element-access-call, callable-array
goal: npm-library-support
related: [1301, 1297]
---
# #1303 — `mws[idx](c, next)` on a closure-typed array compiles to `ref.null`, dropping the call

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
