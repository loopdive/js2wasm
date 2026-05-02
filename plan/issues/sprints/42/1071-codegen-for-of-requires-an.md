---
id: 1071
title: "codegen: for-of requires an array expression — blocks iteration over Map/Set/iterator in bundled JS"
status: done
created: 2026-04-11
updated: 2026-04-12
completed: 2026-04-14
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
language_feature: for-of
goal: iterator-protocol
parent: 1034
closed: 2026-04-12
pr: 137
---
# #1071 — for-of requires an array expression (non-array iterables in bundled JS)

## Implementation Summary

One-line fix in `src/codegen/statements/loops.ts` → `compileForOfIterator`:
added `addIteratorImports(ctx)` call before the `funcMap` lookup in the
host-delegated fallback path. The iterator imports were registered lazily but
never triggered for non-array for-of paths (Map, Set, generators, custom iterables).

Fix: call `addIteratorImports(ctx)` unconditionally in the non-array branch before
looking up `__iterator` in `funcMap`.

6 regression tests added in `tests/issue-1071.test.ts`.
