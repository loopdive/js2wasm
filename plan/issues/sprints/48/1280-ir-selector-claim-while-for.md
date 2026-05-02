---
id: 1280
title: "IR selector: claim while/for-loop bodies with typed numeric state"
status: ready
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, ir
language_feature: while, for, loops
goal: performance, npm-library-support
related: [1169, 1228]
---
# #1280 — IR selector: claim while/for-loop functions

## Problem

The IR selector (`src/ir/select.ts`) currently only claims "tail-shaped" functions: those
whose body is a sequence of `const/let` declarations followed by a single `return` or
`if-else` (both arms tails). Functions with `while` or `for` loops fall to the legacy
direct-AST-to-Wasm path even when all types are typed numeric.

This means important classes of real-world functions (sorting, searching, numeric
algorithms, any accumulator pattern) miss IR path optimizations (constant folding,
dead-code elimination, monomorphization, inline-small).

## Example

```ts
// Falls to legacy despite all types being f64
function sum(arr: number[]): number {
  let total = 0;
  for (let i = 0; i < arr.length; i++) {
    total += arr[i]!;
  }
  return total;
}
```

## Root cause

`src/ir/select.ts` `isPhase1Stmt` only accepts:
- `VariableDeclaration` with `isPhase1Expr` initializer
- `ReturnStatement` with `isPhase1Expr` value
- `IfStatement` with `isPhase1Tail` on both arms

No path for `WhileStatement` or `ForStatement`.

The IR block graph (`br` / `br_if` terminators + back-edges) CAN express loops — the
lowerer already handles them via `block { loop { ... } }`. The gap is only in the
selector + from-ast builder.

## Approach

1. In `select.ts`: extend `isPhase1Stmt` to accept `WhileStatement` and `ForStatement`
   when the condition and update use only `isPhase1Expr` terms, and the body consists
   only of valid Phase 1 statements (no break/continue across functions, no goto).

2. In `from-ast.ts`: add `lowerWhileStatement` and `lowerForStatement` that emit the
   `block { loop { br_if ...; body; br 0 } }` Wasm pattern via `br_if` terminators on
   a fresh loop block-pair.

3. The from-ast layer already has `forof.vec` / `forof.iter` as declarative loop nodes.
   A `while` loop is simpler: just `br_if` on the loop-block back-edge.

## Acceptance criteria

1. `sum([1,2,3,4,5])` → 15 via IR path (WAT shows no legacy fallback)
2. `while (i < 100) i++` compiles via IR
3. `tests/issue-1280.test.ts` WAT snapshot guards confirm IR path is taken
4. No regression in equivalence tests
