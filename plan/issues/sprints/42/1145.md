---
id: 1145
title: "Async generator: undefined tuple elements promote to f64, corrupting sNaN sentinel"
status: done
created: 2026-04-20
updated: 2026-04-20
completed: 2026-04-20
priority: medium
feasibility: medium
reasoning_effort: medium
goal: correctness
---
## Problem

In async generator codegen, `undefined` tuple elements were emitted as f64, which corrupted the sNaN sentinel used to distinguish `undefined` from numeric values. This caused async generator `return` paths to produce wrong values or fail with type mismatches.

## Acceptance Criteria

- [x] Async generator return paths correctly preserve sNaN sentinel
- [x] `undefined` tuple elements do not promote to f64
- [x] Async generator test262 tests pass

## Implementation

Merged via PR #205 (branch `issue-async-gen-return2`).
