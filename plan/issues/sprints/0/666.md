---
id: 666
title: "Suppress 'await outside async' diagnostic (146 CE)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: async-model
test262_ce: 146
files:
  src/compiler.ts:
    breaking:
      - "suppress TS1308 await outside async diagnostic"
---
# #666 — Suppress "await outside async" diagnostic (146 CE)

## Status: open
146 tests fail with "'await' expressions are only allowed within async functions". These are test262 patterns where top-level await is used. Add diagnostic code to DOWNGRADE_DIAG_CODES.
## Complexity: XS
