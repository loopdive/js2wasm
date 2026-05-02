---
id: 1140
title: "Array methods .call() with array-like receiver not supported"
status: done
created: 2026-04-20
updated: 2026-04-20
completed: 2026-04-20
priority: medium
feasibility: medium
reasoning_effort: medium
goal: spec-completeness
---
## Problem

`Array.prototype.reduce.call(arrayLike, fn)` and similar patterns fail because array method implementations assumed a true Wasm vec receiver. Array-like objects (with `length` + numeric keys) must also be supported per spec.

## Acceptance Criteria

- [x] `Array.prototype.reduce.call(arrayLike, fn)` works
- [x] `Array.prototype.map.call(arrayLike, fn)` works
- [x] test262 array-call tests pass

## Implementation

Merged via PR #223 (branch `issue-array-call-arraylike`).
