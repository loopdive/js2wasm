---
id: 961
title: "Promise .then()/.catch()/.finally() regression after #960 removal (1,095 tests)"
status: done
created: 2026-04-05
updated: 2026-04-14
completed: 2026-04-14
priority: critical
feasibility: hard
reasoning_effort: max
goal: async-model
---
# #961 — Promise .then()/.catch()/.finally() regression after #960 removal

## Problem

#960 removed Promise instance method imports (Promise_then/catch/finally) because they corrupted Wasm type indices. But this also removed the actual .then()/.catch()/.finally() handling, causing 1,095 tests to regress:
- 921: "then is not a function"
- 174: "Cannot read properties of null (reading 'then')"

These were NOT false passes — they were real passes where .then() worked via the dedicated handler.

## Root Cause

The #960 fix removed three things:
1. Collector detection of .then()/.catch()/.finally() on Promise receivers
2. Import registration for Promise_then/catch/finally
3. Codegen handler that emitted calls to those imports

The fix was correct for (1) and (2) — registering func types during collection corrupts indices. But (3) means Promise instance methods now fall through to `__extern_method_call`, which doesn't know how to call .then() on a Promise externref.

## Fix Strategy

Re-add Promise instance method support but register the imports DURING CODEGEN (not during collection), using `addUnionImports` / late import mechanism. This avoids the type index corruption while preserving .then() functionality.

Alternatively, ensure `__extern_method_call` can handle .then()/.catch()/.finally() on externref Promise objects.

## Acceptance Criteria

- .then()/.catch()/.finally() work on Promise-typed expressions
- No "invalid Wasm binary" errors from type index corruption
- Pass count recovers to ≥18,594 (sprint 37 baseline)
