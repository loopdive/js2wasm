---
id: 1268
title: "index-signature obj[key] ??= value returns NaN instead of assigning"
status: backlog
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: logical-assignment, index-signature
goal: npm-library-support
related: [1244, 1250]
---
# #1268 — `obj[runtimeKey] ??= newValue` returns NaN on index-signature types

## Problem

Nullish assignment (`??=`) on a **dynamic index** of a TypeScript index-signature type
(`{ [key: string]: T }`) produces `NaN` instead of assigning the value.

Repro (from #1250 investigation):

```ts
type Dict = { [key: string]: number };
const d: Dict = {};
d["x"] ??= 42;
export const result = d["x"]; // expected: 42, actual: NaN
```

The `??=` operator dispatches correctly (short-circuit semantics work), but the underlying
**indexed-set on a dictionary/index-signature type** fails — it stores something that reads
back as NaN.

## Scope

Affects `obj[expr] ??= value` where `obj` is typed as `{ [key: string]: T }` (not a
registered struct or dense array). Regular `obj[key] = value` assignment may also be
affected on index-signature types.

This is out of scope for #1250 (logical assignment operators) since the ??= dispatch is
correct — the bug is in the index-signature element-set codegen path.

## Related

- #1250 — logical assignment operators (confirmed working on struct/array targets)
- #1244 — Hono Tier 2+ uses `this.#children[method] ??= new Node()` which hits this path

## Acceptance criteria

1. `d[key] ??= value` on an index-signature dict assigns and reads back correctly
2. `tests/issue-1268.test.ts` covers the pattern
3. No regression in existing element-access or logical-assignment tests
