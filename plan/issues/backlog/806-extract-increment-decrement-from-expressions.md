---
id: 806
title: "Extract increment/decrement from expressions.ts → unary-update.ts"
status: ready
created: 2026-03-26
updated: 2026-04-28
priority: medium
feasibility: easy
reasoning_effort: medium
goal: maintainability
subtask_of: 688
---
# #806 — Extract increment/decrement from expressions.ts → unary-update.ts

## What moves

~1,500 lines — all prefix/postfix increment/decrement:

- `compileMemberIncDec` (line 6374, 463 lines)
- `compilePrefixUnary` (line 6837, 480 lines)
- `compilePostfixUnary` (line 7317, 230 lines)
- `compilePrefixIncrementProperty` (line 7547)
- `compilePrefixIncrementElement` (line 7629)
- `compilePostfixIncrementProperty` (line 7786)
- `compilePostfixIncrementElement` (line 7875)
- `unwrapParens` (line 6360) — small helper, can stay or move

## Validation

1. `npm test` must pass
2. Test: `i++`, `++i`, `obj.x++`, `arr[i]--`, `--obj.x`
3. No behavior change

## Risk: LOW

Self-contained cluster. Only called from `compileExpressionInner` switch cases.

## Complexity: S
