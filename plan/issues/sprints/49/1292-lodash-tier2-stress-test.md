---
id: 1292
sprint: 49
title: "lodash Tier 2 stress test — memoize, flow, partial application"
status: ready
created: 2026-05-03
updated: 2026-05-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: npm-package-imports, closures, higher-order-functions
goal: npm-library-support
depends_on: [1291]
related: [1278, 1276, 1279]
---
# #1292 — lodash Tier 2 stress test: memoize, flow, partial application

## Background

Lodash Tier 1 covers identity, add, and clamp at the function-compilation level.
Tier 2 exercises patterns that require:
- **memoize**: closures over a `Map`-backed cache (WeakMap variant covered by #1242)
- **flow / flowRight**: function composition via reduce over an array of functions
- **partial / partialRight**: partial application via closure capture of arguments
- **curry**: variadic arity tracking via closure

These patterns exercise HOF composition, closure capture depth, and typed-array
iteration — all areas recently improved in S47 (#1276, #1281, #1280).

## Acceptance criteria

Write `tests/stress/lodash-tier2.test.ts` covering:

1. **memoize (simple)** — `_.memoize(fn)` where `fn: (n: number) => number`.
   Call twice with same arg, assert result identical and `fn` only called once
   (call-count sentinel).

2. **flow** — `_.flow([fn1, fn2, fn3])` where each `fn: (n: number) => number`.
   Assert `flow(1)` equals `fn3(fn2(fn1(1)))`.

3. **partial** — `_.partial(fn, a)` produces a function that calls `fn(a, ...rest)`.
   Assert `partial(2)(3) === fn(2, 3)`.

4. **negate** — `_.negate(pred)` returns `!pred(x)`. Simple boolean flip.

Each tier must:
- Compile the lodash-es module (`compileProject`)
- Instantiate the Wasm module
- Call the exported function with a concrete argument
- Assert the return value matches the expected JS behavior

If any tier fails at compile or instantiate, mark with `it.skip` and an issue ref
(don't block the others).

## Files

- `tests/stress/lodash-tier2.test.ts` (new)
- `plan/issues/sprints/48/1292-lodash-tier2-stress-test.md` — this file

## Notes

- Tier 2 is not about making all of lodash work — it's a probe for specific
  compilation patterns. Each failing tier is a bug report, not a blocker.
- `_.memoize` uses `Map` internally (not `WeakMap`). If `Map` iteration fails,
  document the gap.
- `_.flow` with a typed `fn[]` array exercises IR Array methods (#1233).
