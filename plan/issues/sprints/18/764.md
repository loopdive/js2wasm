---
id: 764
title: "- 'immutable global' assignment error (240 CE)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: spec-completeness
test262_ce: 31
note: "Down from 240 to 31 residual after #704 fix. Low priority now."
---
# #764 -- "immutable global" assignment error (240 CE)

## Problem

240 tests fail with Wasm validation error about assigning to immutable globals. The codegen emits `global.set` for globals declared as immutable (non-mut).

## Likely cause

`const` declarations at module scope create immutable Wasm globals, but the test code or preamble tries to reassign them (e.g. through eval, or the test intentionally tests const reassignment which should throw TypeError, not CE).

## Fix approach

Either make module-scope const globals mutable (Wasm `(mut)`) since JS const semantics are enforced at compile time not runtime, or add a pre-check that skips codegen for assignments to const.

## Acceptance criteria

- const globals compile without CE
- Reassignment to const throws TypeError at runtime (not CE)
