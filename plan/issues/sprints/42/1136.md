---
id: 1136
title: "Array.prototype.flat() and flatMap() not implemented"
status: done
created: 2026-04-20
updated: 2026-04-28
completed: 2026-04-28
priority: medium
feasibility: medium
reasoning_effort: medium
goal: platform
---
## Problem

`Array.prototype.flat()` (ES2019) and `flatMap()` are not implemented. Programs using lodash or standard array operations that rely on these methods fail at runtime.

## Acceptance Criteria

- [x] `Array.prototype.flat(depth?)` flattens nested arrays up to `depth` levels
- [x] `Array.prototype.flatMap(fn)` maps then flattens one level
- [x] test262 tests pass for both methods

## Implementation

Implemented via host imports (`__array_flat`, `__array_flatMap`) in runtime.ts with a `_toJsArray` helper to convert WasmGC vec structs to plain JS arrays.

Merged via PR #190 (branch `issue-1136-array-flat`).
