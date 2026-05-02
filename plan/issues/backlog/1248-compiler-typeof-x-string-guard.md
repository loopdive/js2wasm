---
id: 1248
title: "compiler: typeof x === 'string' guard breaks String.prototype.substring(start) — returns single char"
status: ready
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: type-narrowing
goal: npm-library-support
depends_on: []
related: [1244]
created: 2026-05-02
updated: 2026-05-02
es_edition: ES5
origin: "Surfaced by #1244 Hono Tier 1c stress test. The natural way to write a parameterised-route matcher uses `typeof seg === 'string'` as a type guard before calling `seg.substring(1)`; that path silently miscompiles."
---

# #1248 — `typeof x === "string"` guard breaks `String.prototype.substring(start)` (single-arg form)

## Problem

When the compiler narrows an `any`-typed value to `string` via a `typeof
… === "string"` guard, subsequent `substring(start)` calls return only
the **first character** instead of the substring from `start` to the
end of the source string.

Minimal repro (works correctly without the guard, broken with it):

```ts
export function withGuard(seg: any): any {
  if (typeof seg === "string" && seg.charAt(0) === ":") {
    return seg.substring(1);   // ← returns ":" instead of "id"
  }
  return null;
}
export function noGuard(seg: any): any {
  if (seg.charAt(0) === ":") {
    return seg.substring(1);   // ← returns "id" — correct
  }
  return null;
}
```

For input `":id"`:
- `withGuard` returns `":"` (1 char, wrong)
- `noGuard` returns `"id"` (2 chars, correct, matches V8)

The same diagnosis applies to all `substring(start)` calls on a
typeof-string-narrowed local; the two-arg `substring(start, end)` form
is not yet probed.

## Root cause hypothesis

After narrowing `seg: any` to `string`, the call-site dispatch picks a
different `substring` implementation (likely the native-string codegen
path in `src/codegen/string-ops.ts`) that mishandles the single-arg
form — possibly invoking `charAt(start)` or `substring(start, start+1)`
instead of `substring(start, length)`.

The `String.prototype.substring` host import is unaffected (the
`noGuard` form goes through it correctly).

## Why it matters

This is the natural way to write any function that branches on
"is this a string, and if so look at its content". Every npm library
stress test (lodash, prettier, hono, …) likely tickles this pattern —
silent miscompiles produce wrong outputs without crashing, so the bug
hides until something downstream observes the truncated value.

#1244 (Hono Tier 1c) hit this on the first test that handled
parameterised routes. The workaround used there is to drop the
`typeof` guard, which works only because we know the segments are
strings by construction.

## Fix sketch

In `src/codegen/string-ops.ts:compileNativeStringMethodCall` (or
wherever the type-narrowed `string` dispatch picks `substring`),
ensure the single-arg form `s.substring(start)` lowers to
`s.substring(start, s.length)`, not to `s.substring(start, start + 1)`
or `s.charAt(start)`.

A regression test in `tests/issue-1248.test.ts` should exercise both
the typeof-guarded and bare forms, asserting they produce the same
output on a 5-char source string with `start = 1`.

## Acceptance criteria

1. Minimal repro returns `"id"` from both `withGuard` and `noGuard`.
2. `tests/issue-1248.test.ts` covers the single-arg `substring` form
   under typeof narrowing.
3. No regression in `tests/string-methods.test.ts` or
   `tests/equivalence/` string tests.
4. `tests/stress/hono-tier1.test.ts` Tier 1c can be re-written with
   the natural `typeof seg === "string"` guard and still pass.

## Related

- #1244 — Hono stress test that surfaced this
- #1247 — typed `string[]` parameter triggers struct-type mismatch
  (also discovered in #1244)
