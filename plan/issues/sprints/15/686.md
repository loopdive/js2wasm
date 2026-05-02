---
id: 686
title: "Closure capture type preservation"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: performance
files:
  src/codegen/expressions.ts:
    breaking:
      - "keep concrete types for closure captures instead of widening to externref"
---
# #686 — Closure capture type preservation

## Status: review

### Implementation summary

All three objectives from the original issue are already implemented:

1. **Concrete-typed ref cells** -- `getOrRegisterRefCellType()` in `src/codegen/index.ts` (line 8874) creates ref cell structs using the variable's actual type: `(struct (field $value (mut f64)))` for numbers, `(mut i32)` for booleans, `(ref null N)` for struct refs. The key is `valType` in the ref cell registration, which comes directly from the local/param type.

2. **Read-only capture elimination** -- Non-mutable captures are passed by value in the closure struct field (not wrapped in ref cells). See `compileArrowAsClosure` in `src/codegen/closures.ts` line 900-904.

3. **Boxed capture propagation** (commit e4a2da95) -- Non-mutable captures of already-boxed variables correctly register in `liftedFctx.boxedCaptures` so nested closures dereference through the ref cell.

### Verification

WAT output for `let count = 0; const inc = () => { count++; };` produces:
- `(type $__ref_cell_f64 (struct (field $value (mut f64))))` -- NOT externref
- Read-only captures (e.g., `const x = 42; const fn = () => x + 1;`) produce no ref cell at all

The only case where externref ref cells appear is when the variable's TypeScript type genuinely resolves to externref (e.g., `any`, `string` in non-native-string mode).

### Tests
9 tests in `tests/issue-686.test.ts` covering:
- Typed ref cells for f64 and i32 captures (WAT verification)
- Read-only capture elimination (WAT verification)
- Runtime correctness: counters, toggles, compound assignment, nested closures, generators

## Complexity: S (verification + test coverage -- the optimization was already implemented)
