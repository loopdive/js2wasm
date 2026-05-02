---
id: 655
title: "- Stack fallthrough errors (671 CE)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-03-20
priority: high
feasibility: medium
goal: compilable
test262_ce: 671
files:
  src/codegen/stack-balance.ts:
    new:
      - "stack-balancing fixup pass for Wasm function bodies"
  src/codegen/index.ts:
    breaking:
      - "integrate stack-balance pass after peephole optimization"
---
# #655 -- Stack fallthrough errors (671 CE)

## Status: review

671 tests fail with "expected N elements on the stack for fallthru". Up from 300 pre-session (more tests attempted with SKIP_DISABLED). Wasm validation requires all branches to leave the stack in the same state.

### Root cause
Conditional expressions/if statements where one branch produces a value and the other doesn't. The previous fix (#650) addressed addUnionImports double-shifting but this is a different pattern -- genuine branch type mismatches.

## Complexity: M

## Implementation Summary

### What was done
Added a post-compilation **stack-balancing fixup pass** (`src/codegen/stack-balance.ts`) that walks the Wasm instruction tree and fixes stack mismatches in structured control flow (`if`, `try`, `block`, `loop`).

The pass uses a lightweight stack-depth simulator that computes the net stack delta for instruction sequences by tracking push/pop effects of each Wasm instruction. For `call` instructions, it resolves the function signature from the module's type table to compute accurate deltas.

For each structured block:
- If a branch leaves **too many values** (e.g., "expected 0, found N"), it appends `drop` instructions
- If a branch produces **too few values** (e.g., "expected 1, found 0"), it appends a typed default value push (or `unreachable` for unreachable branches)
- Also fixes **function-level** bodies where the return value count doesn't match the declared result type

### Results
- **298 out of 671 (44%)** fallthru errors eliminated
- Remaining 76 are **type mismatches** (e.g., "expected f64, got externref") from deeper codegen issues where the branch types themselves are wrong -- these need per-site codegen fixes, not a post-pass
- 297 additional tests have different Wasm validation errors exposed once the stack count is fixed

### Files changed
- `src/codegen/stack-balance.ts` (new) -- stack-balancing fixup pass
- `src/codegen/index.ts` -- integrate pass after peephole optimization
- `tests/stack-balance.test.ts` (new) -- 7 equivalence tests for stack balance scenarios

### What worked
- Post-compilation fixup approach is safe and doesn't break any existing tests
- Stack delta simulation with function signature resolution handles most instructions accurately
- Handles `if`, `try`, `block`, `loop`, and function-level bodies

### What didn't work / limitations
- Cannot fix **type mismatches** where branches produce different types (73 tests)
- Cannot fix incorrect function indices from addUnionImports shifting (separate issue)
- 3 `finally`-block tests remain due to incorrect codegen of the finally clause (wrong function calls)
