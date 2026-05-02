---
id: 536
title: "Spread types may only be created from object types (16 CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: contributor-readiness
test262_ce: 16
files:
  src/codegen/expressions.ts:
    new:
      - "compileSpreadExpression — handle spread in non-array/non-call positions"
    breaking: []
---
# #536 — Spread types may only be created from object types (16 CE)

## Status: open

16 tests fail with "Spread types may only be created from object types." The compiler encounters spread in contexts it doesn't support (e.g., object spread from non-object sources).

## Complexity: S
