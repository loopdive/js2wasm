---
id: 625
title: "Wasm local.set type mismatch (552 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: compilable
required_by: [658]
test262_ce: 552
files:
  src/codegen/expressions.ts:
    breaking:
      - "local.set type mismatch — value type doesn't match local declaration"
---
# #625 — Wasm local.set type mismatch (552 CE)

## Status: review

552 tests fail with Wasm validation: local.set expects one type but receives another. Common patterns:
- `local.set expected (ref null N), found externref`
- `local.set expected f64, found i32`
- `local.set expected externref, found (ref null N)`

### Root cause
In `compileVariableStatement` (statements.ts), after `coerceType` is called but fails to emit any instructions (e.g., for unrelated struct types), `stackType` was unconditionally updated to `wasmType`. This hid the type mismatch from `emitCoercedLocalSet`, which would otherwise detect it and update the local's declared type.

All 552 errors were `local.set[0]` -- the first local variable in a function. The primary pattern (426/552) was struct type mismatch where `resolveWasmType` inferred one vec/struct type but `compileExpression` produced a different one.

### Fix
Check `fctx.body.length` before and after `coerceType` to detect no-op coercions. Only update `stackType` when coercion actually emitted instructions. When coercion is a no-op, `emitCoercedLocalSet` sees the real stack type and updates the local's declared type to match.

## Complexity: S

## Implementation Summary

### What was done
- Fixed `compileVariableStatement` in `src/codegen/statements.ts` to detect no-op coercions
- Added body-length check around `coerceType` call to preserve actual stack type when coercion fails
- Added 3 regression tests in `tests/local-set-type-mismatch.test.ts`

### Files changed
- `src/codegen/statements.ts` (lines 584-593) -- 1 code change
- `tests/local-set-type-mismatch.test.ts` -- new test file

### What worked
- The fix is minimal (6 lines of logic change) and precisely targets the root cause
- `emitCoercedLocalSet` already handles the type update; the bug was just hiding the mismatch from it
