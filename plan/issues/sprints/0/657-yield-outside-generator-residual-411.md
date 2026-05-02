---
id: 657
title: "Yield outside generator residual (411 CE)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: spec-completeness
depends_on: [628]
test262_ce: 411
files:
  src/codegen/expressions.ts:
    breaking:
      - "propagate isGenerator flag to more contexts"
---
# #657 — Yield outside generator residual (411 CE)

## Status: open

411 tests still hit "yield expression outside of generator function". #628 added the isGenerator flag but 411 remain — likely nested arrow functions inside generators, eval contexts, or class method bodies.

## Complexity: S
