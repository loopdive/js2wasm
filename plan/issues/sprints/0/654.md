---
id: 654
title: "Missing property diagnostics (1,116 CE)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: easy
goal: builtin-methods
test262_ce: 1116
files:
  src/compiler.ts:
    breaking:
      - "suppress more TS diagnostics for property access patterns"
---
# #654 — Missing property diagnostics (1,116 CE)

## Status: open

1,116 tests fail with "Property X does not exist on type Y". These are TS type checker errors for JS patterns that are valid at runtime (duck typing, prototype extensions).

### Fix
Add more diagnostic codes to DOWNGRADE_DIAG_CODES in src/compiler.ts. The most common:
- "does not exist on type" (TS2339)
- RegExp flag targeting errors (TS1503 — "only available when targeting es2024")
- Import declaration position (TS1232)

## Complexity: S
