---
id: 535
title: "'delete' cannot be called on identifier in strict mode (20 CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: test-infrastructure
test262_ce: 20
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "suppress TS strict-mode delete diagnostic in allowJs mode"
---
# #535 — 'delete' cannot be called on identifier in strict mode (20 CE)

## Status: open

20 tests fail because TypeScript rejects `delete x` in strict mode. Suppress this diagnostic in allowJs/test262 mode.

## Complexity: XS
