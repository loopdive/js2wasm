---
id: 688
title: "Refactor codebase into smaller modules per language feature"
status: done
created: 2026-03-20
updated: 2026-04-28
completed: 2026-04-28
priority: medium
feasibility: hard
reasoning_effort: max
goal: maintainability
required_by: [742]
files:
  src/codegen/expressions.ts:
    breaking:
      - "split 27K line file into modules per language feature"
---
# #688 — Refactor codebase into smaller modules per language feature

## Status: open

expressions.ts is 27K lines. Split into ~10 modules per language feature.

## Split plan (in order of safety/independence)

| #   | New File             | ~Lines | Key Functions                                                                               | Risk                        |
| --- | -------------------- | ------ | ------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | `array-methods.ts`   | 3,500  | compileArray\*, setupArrayCallback, buildClosureCallInstrs                                  | Low — self-contained        |
| 2   | `string-ops.ts`      | 1,500  | compileStringLiteral, compileTemplate\*, compileNativeStringMethodCall                      | Low                         |
| 3   | `binary-ops.ts`      | 2,000  | compileBinaryExpression, compileNumericBinaryOp, compileBitwiseBinaryOp                     | Low                         |
| 4   | `generators.ts`      | 500    | compileYieldExpression, generator helpers                                                   | Low                         |
| 5   | `typeof-delete.ts`   | 800    | compileTypeofExpression, compileDeleteExpression, compileInstanceOf                         | Low                         |
| 6   | `closures.ts`        | 2,500  | compileArrowFunction, compileArrowAsClosure, compileArrowAsCallback                         | Medium — many shared deps   |
| 7   | `object-ops.ts`      | 1,500  | compileObjectDefineProperty, compileObjectKeysOrValues                                      | Medium                      |
| 8   | `property-access.ts` | 2,500  | compilePropertyAccess, emitNullGuardedStructGet, emitExternrefToStructGet                   | HIGH — most actively edited |
| 9   | `calls.ts`           | 3,000  | Call dispatch, method calls, .call/.apply, super, new                                       | HIGH — many code paths      |
| 10  | `expressions.ts`     | 4,000  | Entry point: compileExpression, switch dispatcher, identifiers, literals, unary, assignment | Stays                       |

## Principles

- **No behavior change** — pure refactor, same exports
- **One module per PR** — easier to review, catch regressions
- **Tests must pass after each split**
- **Do NOT split while agents are editing the same functions** — check worktree diffs first
- **compileExpressionInner stays in expressions.ts** — it's the switch dispatcher

## Execution order

Start with #1 (array-methods) — safest, biggest, most self-contained. Do high-risk splits (#8, #9) last when no agents are active.

## Complexity: XL
