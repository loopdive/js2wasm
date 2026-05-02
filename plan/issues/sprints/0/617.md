---
id: 617
title: "Wasm validation: not enough arguments for drop (109 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: compilable
test262_ce: 109
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "ensure stack is clean before drop instruction"
---
# #617 — Wasm validation: not enough arguments for drop (109 CE)

## Status: in-progress

109 tests fail with "not enough arguments on the stack for drop (need 1, got 0)". The compiler emits a `drop` instruction when the stack is empty.

This happens when an expression is expected to produce a value (for dropping) but the codegen path produces void instead. Likely in async function returns or conditional expressions where one branch is void.

## Complexity: S
