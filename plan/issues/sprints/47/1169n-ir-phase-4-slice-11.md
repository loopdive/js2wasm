---
id: 1169n
title: "IR Phase 4 Slice 11 — switch statements + missing binary/unary operators through IR"
status: done
created: 2026-05-01
updated: 2026-05-01
completed: 2026-05-01
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: ir
language_feature: switch, bitwise, nullish-coalescing, optional-chaining
goal: core-semantics
required_by: [1169o, 1169q, 1231]
es_edition: ES2020
related: [1169, 1168]
---
# #1169n — IR Phase 4 Slice 11: switch + missing operators

## Problem

`isPhase1Expr` and `isPhase1StatementList` in `src/ir/select.ts` reject several
common patterns, causing entire functions to fall back to the legacy path:

**Missing from `isPhase1StatementList`:**
- `switch` statements (`SwitchStatement`) — very common in test262, disqualifies most enum-dispatch and parser functions

**Missing from `isPhase1BinaryOp`:**
- Arithmetic: `%` (RemainderToken), `**` (AsteriskAsteriskToken)
- Bitwise: `&`, `|`, `^`, `>>`, `<<`, `>>>`
- Logical: `??` (QuestionQuestionToken), `in`, `instanceof`

**Missing from `isPhase1Expr`:**
- `delete expr` (DeleteExpression)
- `void expr` (VoidExpression)
- Optional chaining: `obj?.prop`, `fn?.()` (OptionalChain*)

## What this unlocks

`switch` alone disqualifies a large fraction of test262 functions. Landing this
slice significantly widens `planIrCompilation`'s claim set without requiring
new IR subsystems — the IR already has conditional branching and block structure.

## Acceptance criteria

1. `isPhase1StatementList` accepts `switch` statements (all case/default arms must
   themselves be Phase-1 statement lists; `break` within switch is allowed)
2. All missing binary operators listed above accepted by `isPhase1BinaryOp`
3. `delete`, `void`, and optional-chaining expressions accepted by `isPhase1Expr`
4. Corresponding lowering in `src/ir/from-ast.ts` / `src/ir/lower.ts` emits
   correct Wasm for each new construct
5. Equivalence tests pass; test262 does not regress; net improvement expected

## Implementation notes

- `switch` → Wasm `block`/`br_table` or chained `if`/`else if` depending on
  key type (integer → `br_table`, otherwise chained compare). Architect to
  recommend.
- `%`, `**` → `f64.rem` analogue via `fmod` or JS semantics wrapper; `**` →
  `Math.pow` call or `f64` pow instruction
- Bitwise ops → convert operands to i32, apply op, convert back to f64
  (same pattern as legacy `compileBinaryExpression` for bitwise)
- `??` → IR conditional with null/undefined check on left operand
- `?.` → IR conditional null-guard before property access / call
- `instanceof` → extern class check via `getExternClassInfo`; local class →
  `ref.test`
- `in` → call to legacy host or stub returning false for IR (deferred if complex)
- `delete` → always returns `true` for local vars/props in strict mode;
  `void` → lower operand for side effects, result `undefined`

## Out of scope

- Dynamic element access (`arr[i]` with non-string key) — see #1169o
- String/array prototype methods — see #1169p
