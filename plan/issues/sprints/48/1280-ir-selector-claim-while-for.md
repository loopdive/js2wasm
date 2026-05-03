---
id: 1280
sprint: 48
title: "IR selector: claim while/for-loop bodies with typed numeric state"
status: done
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

## Resolution (2026-05-03)

Lands two new declarative IR instructions — `while.loop` and
`for.loop` — that mirror the existing `forof.*` family. Both carry a
condition buffer, a body buffer, and (for `for.loop`) an update
buffer; the IR lowerer emits the canonical
`block { loop { <cond>; i32.eqz; br_if 1; <body>; <update?>; br 0 } }`
Wasm pattern.

### Files changed

- `src/ir/nodes.ts` — `IrInstrWhileLoop` / `IrInstrForLoop`
  interfaces + addition to the `IrInstr` union.
- `src/ir/builder.ts` — `emitWhileLoop` / `emitForLoop` builder
  methods.
- `src/ir/select.ts` — `isPhase1WhileStatement`,
  `isPhase1ForStatement`, `isPhase1ForUpdateExpr`. Wired into
  `isPhase1StatementList` (top-level claim) and
  `isPhase1BodyStatement` (nested in for-of / loop bodies).
  Postfix `i++` / `i--` and prefix `++i` / `--i` accepted as
  expression-statement body shapes.
- `src/ir/from-ast.ts` — `lowerWhileStatement`, `lowerForStatement`,
  `lowerForUpdateExpr`, `lowerIncrementDecrement`. Wired into top-
  level statement dispatch and the body-statement dispatcher.
- `src/ir/lower.ts` — `case "while.loop"` / `case "for.loop"`
  emission. Updated `registerInstrDefs`, `recordUse`,
  `allocLocalForInstr`, `collectIrUses`, `collectForOfBodyUses` to
  walk the new buffers.
- `src/ir/passes/dead-code.ts`, `inline-small.ts`,
  `monomorphize.ts`, `verify.ts` — exhaustive switch arms for the
  new instr kinds.

### Test results

- `tests/issue-1280.test.ts` — 9 / 9 passing. Covers:
  - while-loop accumulator (sum 0..9)
  - while-loop factorial (mul accumulator, descending counter)
  - for-loop with `i++` update
  - for-loop with explicit `i = i + 1` update
  - for-loop with compound `i += 2` update
  - for-loop with descending `i--` update
  - nested while inside for (triangular sum)
  - WAT snapshot for both shapes confirms `block { loop { ... } }` Wasm
- `tests/equivalence/` (13 files, ~365 tests) — identical pass/fail
  counts vs main (only timing differences). Zero regressions.
- IR-specific tests (`tests/ir/`, `tests/issue-1228.test.ts`,
  `tests/issue-1244.test.ts`) — all green.

### Notes

- Increment / decrement (`i++` / `i--`) restricted to f64 slot
  bindings — the IR's `IrBinop` set only includes f64 arithmetic,
  not i32. i32-typed counters fall back to legacy via the lowerer's
  throw. Adding i32 binops is a separate slice (and out of #1280's
  acceptance scope).
- If/return inside loop bodies is intentionally NOT included in
  this slice — body statements remain restricted to the for-of
  body grammar (var decl, assignment, postfix increment, nested
  loop). Adding if/early-return inside the body is a follow-up.
