---
id: 1115
renumbered_from: 512
title: "Fix illegal cast when closures are passed as callable parameters"
sprint: 21
status: done
priority: high
goal: crash-free
created: 2026-03-18
completed: 2026-03-18
---

# Issue #1115: Fix "RuntimeError: illegal cast" for closures passed as callable parameters

## Problem

388 test262 tests fail with `RuntimeError: illegal cast`. The `ref.cast` instruction
encounters a value whose runtime type doesn't match the expected struct type.

Root causes identified:

1. **Return type `never` vs `void` mismatch**: Functions that always throw have return
   type `never`, which resolves to `externref`. This creates a different wrapper struct
   signature (`->externref`) than the `() => void` signature expected by callers (`->`).

2. **Closures with captures have unique struct types**: When a closure captures variables,
   it gets a unique struct type with extra fields for captures. But the callee expects
   the shared wrapper struct type. `ref.cast $wrapperStruct` fails because the runtime
   value is a different, unrelated struct type.

3. **Double-boxing of mutable captures**: When multiple closures capture the same mutable
   variable, the second closure wraps the already-boxed ref cell in ANOTHER ref cell,
   creating a type mismatch at `struct.new`.

## Solution

1. **Treat `never` as `void`** in closure return type resolution. A function returning
   `never` (always throws) never produces a value, so its closure wrapper should have
   no return type, matching `() => void`.

2. **Make closure structs with captures subtypes** of the shared wrapper struct. The
   wrapper struct is marked non-final (`superTypeIdx = -1`), and captured closure
   structs set `superTypeIdx` to the wrapper. This makes `ref.cast $wrapperStruct`
   succeed for any closure with the same signature. The lifted function type is shared
   across all closures with the same signature, and inside the lifted body, a
   `ref.cast` to the specific subtype extracts captures.

3. **Detect already-boxed captures** to avoid double-wrapping. When a mutable variable
   is already boxed from a previous closure, subsequent closures store the ref cell
   directly instead of creating a ref cell of a ref cell.

## Implementation Summary

### What was done
- Added `never` type check alongside `void` when computing closure return types
- Made wrapper structs non-final via `superTypeIdx: -1`
- Closure structs with captures now extend the corresponding wrapper struct
- Lifted functions for captured closures share the wrapper's func type; inside the
  body, `ref.cast` to the subtype accesses captures
- Added `alreadyBoxed` flag to capture analysis to prevent double-boxing
- Added 6 equivalence tests covering the fix

### Files changed
- `src/codegen/expressions.ts` — closure compilation, capture analysis, struct creation
- `tests/equivalence/illegal-cast-assert-throws.test.ts` — new test file

### What worked
- WasmGC struct subtyping enables `ref.cast` to succeed for any closure subtype
- Sharing the lifted func type across closures of the same signature ensures `call_ref` works
- The `alreadyBoxed` flag cleanly prevents the double-boxing issue

### Tests now passing
- 6 new equivalence tests (all pass)
- No regressions in existing equivalence tests
