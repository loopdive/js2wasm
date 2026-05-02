---
id: 911
title: "Split statements.ts into control-flow, variables, destructuring, loops, and functions modules"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: core-semantics
depends_on: [909]
required_by: [912, 1013]
files:
  src/codegen/statements.ts:
    modify:
      - "Break the monolithic statement lowering file into feature-oriented modules"
  src/codegen/statements/:
    add:
      - "Introduce modules for variables, destructuring, control flow, loops, exceptions, and nested declarations"
---
# #911 -- Split statements.ts into control-flow, variables, destructuring, loops, and functions modules

## Problem

[src/codegen/statements.ts](src/codegen/statements.ts) currently contains a very broad mix of statement-lowering logic:

- variable declarations
- destructuring declarations
- default parameter handling
- `if` / `switch`
- `for` / `while` / `do`
- `for-of` / `for-in`
- throw / try-catch
- nested functions and classes
- `arguments` object handling

That file is large enough that contributors will hesitate to touch it unless they already know the compiler internals.

## Goal

Split statement lowering into modules that match how humans search for language features.

## Requirements

1. Introduce a `src/codegen/statements/` folder with modules for:
   - variables
   - destructuring
   - control-flow statements
   - loop statements
   - exceptions
   - nested functions/classes
2. Keep a small public statement dispatcher
3. Move helper routines next to the statement family that owns them
4. Preserve behavior and current tests
5. Make file names correspond to contributor intuition about where to edit a feature

## Acceptance criteria

- statement lowering is no longer concentrated in one multi-thousand-line file
- loop-specific, exception-specific, and destructuring-specific logic live in separate files
- contributors can localize a statement bug/fix quickly

## Implementation Summary

Split the 7557-line `src/codegen/statements.ts` into 8 focused modules under `src/codegen/statements/`:

| Module | Responsibility |
|--------|---------------|
| `shared.ts` | `collectInstrs`, `adjustRethrowDepth`, block-scope shadow save/restore |
| `tdz.ts` | Temporal dead zone init and check helpers |
| `variables.ts` | Variable declarations (`var`/`let`/`const`) |
| `destructuring.ts` | Object, array, and string destructuring patterns |
| `control-flow.ts` | `return`, `if`, `switch`, `break`, `continue`, labeled |
| `loops.ts` | `while`, `for`, `do-while`, `for-of`, `for-in` |
| `exceptions.ts` | `throw`, `try-catch-finally` |
| `nested-declarations.ts` | Nested function/class declarations, `arguments` object, hoisting |

`src/codegen/statements.ts` (371 lines) is now a slim dispatcher that imports from all sub-modules and re-exports the original public API surface.

**Circular deps**: sub-modules that call `compileStatement` import it from `../statements.js`. This is the same pattern as the pre-existing `statements.ts ↔ index.ts` circular dep and works in ESM because the circular reference is only called inside function bodies, not at init time.

## Test Results

Equivalence tests: **zero regressions** introduced. All 17 pre-existing failures on `main` (async-function, tdz-reference-error, default-parameters, destructuring-extended) fail identically before and after the split. All previously-passing tests continue to pass.

`tsc --noEmit`: **zero errors**.
