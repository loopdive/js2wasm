---
id: 1248
title: "compiler: typeof x === 'string' guard breaks String.prototype.substring(start) — returns single char"
status: done
created: 2026-05-02
updated: 2026-05-02
completed: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-narrowing, string-methods
goal: npm-library-support
related: [1244, 1247]
---
# #1248 — `typeof x === "string"` guard breaks `String.prototype.substring(start)` (single-arg form)

## Problem

When the compiler narrows an `any`-typed value to `string` via a `typeof … === "string"` guard,
subsequent `substring(start)` calls return only the **first character** instead of the substring
from `start` to the end of the string.

```ts
export function withGuard(seg: any): any {
  if (typeof seg === "string" && seg.charAt(0) === ":") {
    return seg.substring(1);   // ← returns ":" instead of "id" for input ":id"
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

For input `":id"`: `withGuard` returns `":"`, `noGuard` returns `"id"`.

## Root cause hypothesis

After `typeof seg === "string"` narrows the local, the call-site dispatch picks a different
`substring` implementation (the native-string codegen path) that mishandles the single-arg form —
likely invoking `charAt(start)` or `substring(start, start+1)` instead of `substring(start, length)`.

In `src/codegen/string-ops.ts:compileNativeStringMethodCall` (or wherever type-narrowed `string`
dispatch occurs), ensure `s.substring(start)` lowers to `s.substring(start, s.length)`.

## Acceptance criteria

1. Minimal repro returns `"id"` from both `withGuard` and `noGuard` for input `":id"`.
2. `tests/issue-1248.test.ts` covers single-arg `substring` under typeof narrowing.
3. No regression in `tests/string-methods.test.ts` or `tests/equivalence/` string tests.
4. `tests/stress/hono-tier1.test.ts` Tier 1c can use the natural `typeof seg === "string"` guard.

## Related

- #1244 — Hono stress test that surfaced this
- #1247 — typed `string[]` parameter triggers struct-type mismatch (also found in #1244)
