---
id: 668
title: "'String literal not registered' for empty string (43 CE)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: contributor-readiness
test262_ce: 43
files:
  src/codegen/index.ts:
    breaking:
      - "register empty string in string literal pool"
---
# #668 — "String literal not registered" for empty string (43 CE)

## Status: open
43 tests fail with 'String literal not registered: ""'. The string pool misses the empty string. Add it during initialization.
## Complexity: XS
