---
id: 777
title: "- 'immutable global' assignment error (240 CE)"
status: done
created: 2026-03-22
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: compilable
test262_ce: 240
---
# #777 -- "immutable global" assignment error (240 CE)

## Problem

240 tests fail with Wasm validation error about assigning to immutable globals. The codegen emits `global.set` for globals declared as immutable (non-mut).

## Likely cause

`const` declarations at module scope create immutable Wasm globals, but the test code or preamble tries to reassign them (e.g. through eval, or the test intentionally tests const reassignment which should throw TypeError, not CE).

## Fix approach

Either make module-scope const globals mutable (Wasm `(mut)`) since JS const semantics are enforced at compile time not runtime, or add a pre-check that skips codegen for assignments to const.

## Acceptance criteria

- const globals compile without CE
- Reassignment to const throws TypeError at runtime (not CE)
