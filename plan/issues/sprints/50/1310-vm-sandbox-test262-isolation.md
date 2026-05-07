---
id: 1310
title: "test262 global contamination: vm.createContext sandbox isolation"
status: done
priority: medium
sprint: 50
pr: 232
---

## Problem

test262 tests compiled to Wasm can pollute the host JS globals through `__extern_set`
host imports. When `resolveImport`'s `declared_global` case resolved names via
`(globalThis as any)[name]`, a test that overwrote a built-in (e.g. `Array.prototype.push`)
would corrupt the shared `globalThis`, causing subsequent tests to see mutated built-ins.

This introduced flaky test-level contamination independent of the runner-pool contention
drift fixed by PR #228.

## Fix

- `runtime.ts`: `buildImports` / `resolveImport` accept an optional `globalSandbox`
  parameter; `declared_global` reads from `globalSandbox` when provided, otherwise falls
  back to `globalThis`.
- `tests/test262-runner.ts`: per-shard vm.createContext sandbox with sentinel dirty-check.
  Five built-in method references (Array.prototype.push, Object.prototype.hasOwnProperty,
  Function.prototype.call, String.prototype.slice, Promise.prototype.then) are captured at
  sandbox creation. Before each test, sentinels are checked; sandbox is recycled only when
  any sentinel differs. This avoids the cost of a fresh context per test while still
  catching contamination as soon as it occurs.

## Implementation notes

`vm.createContext({})` does NOT auto-populate built-ins as properties — they must be
materialized via `runInContext("Array", ctx)`. Dev confirmed this and handled it correctly
in the implementation.

## Merged

PR #232 — 2026-05-07
