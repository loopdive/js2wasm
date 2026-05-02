---
id: 837
title: "Stage 3: Map/WeakMap upsert — getOrInsert, getOrInsertComputed"
status: ready
created: 2026-03-28
updated: 2026-04-28
priority: low
feasibility: easy
reasoning_effort: medium
goal: platform
test262_skip: ~110
---
# #837 -- Map/WeakMap upsert methods (getOrInsert/getOrInsertComputed)

## Problem

~110 tests use `Map.prototype.getOrInsert`, `Map.prototype.getOrInsertComputed`, and the WeakMap equivalents. These are from the TC39 Stage 3 "upsert" proposal. Not registered as host imports.

Currently skipped via the `upsert` feature flag.

## Fix

Register getOrInsert and getOrInsertComputed as extern class method imports for Map and WeakMap. The JS runtime already supports them in modern engines.

## Acceptance criteria

- 4 methods registered as host imports
- ~110 tests unskipped and running
