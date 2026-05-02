---
id: 1146
title: "for-of: nested rest binding patterns not decoded (825 ary-rest-rest cluster)"
status: done
created: 2026-04-20
updated: 2026-04-20
completed: 2026-04-20
priority: medium
feasibility: medium
reasoning_effort: medium
goal: crash-free
depends_on: [825]
---
## Problem

`for-of` loops with nested array rest patterns (e.g. `for (const [...[a, b]] of arr)`) were not recursing into the inner binding pattern. Only the top-level rest element was extracted; nested destructuring was skipped. Part of the #825 null-dereference cluster.

## Acceptance Criteria

- [x] `for (const [...[a, b]] of arr)` correctly binds `a` and `b`
- [x] `for (const [...{length}] of arr)` correctly binds `length`
- [x] test262 ary-rest-rest cluster passes

## Implementation

Merged via PR #209 (branch `issue-825-class-dstr-fn-name`). Sub-issue of #825.
