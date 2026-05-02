---
id: 391
title: "Numeric index signature on object types"
status: done
created: 2026-03-16
updated: 2026-04-14
completed: 2026-03-16
priority: medium
goal: test-infrastructure
---
# Issue #391: Numeric index signature on object types (30 CE)

31 test262 tests fail with compile errors because TypeScript diagnostic TS7053
("Element implicitly has an 'any' type because expression of type 'X' can't be
used to index type 'Y'") was not being downgraded to a warning.

## Root Cause

The TypeScript type checker emits TS7053 when code uses a string or numeric
index on an object type that lacks a matching index signature (e.g.,
`obj[key]` where `obj` is `{}`). This is a type-level warning that should not
block compilation, since the codegen already has an externref fallback path for
element access on struct types (added in #388/#389).

The `DOWNGRADE_DIAG_CODES` set was missing code 7053, so these diagnostics
were treated as hard errors, blocking compilation of 31 test262 tests.

## Implementation Summary

**What was done:**
- Added TS7053 to the `DOWNGRADE_DIAG_CODES` set so the diagnostic is treated
  as a warning instead of an error
- Moved `DOWNGRADE_DIAG_CODES` from a local variable inside `compileSource()`
  to module scope so it can be shared with `compileToObjectSource()`
- Updated `compileToObjectSource()` to use the shared downgrade set (it was
  previously hardcoding all diagnostics as `severity: "error"`)
- Added 4 equivalence tests for numeric/string index access on plain objects

**Files changed:**
- `src/compiler.ts` -- moved DOWNGRADE_DIAG_CODES to module scope, added 7053,
  updated compileToObjectSource to use the shared set
- `tests/equivalence/numeric-index-signature.test.ts` -- new test file

**Tests now passing:** 4 new equivalence tests, ~31 test262 compile errors resolved
