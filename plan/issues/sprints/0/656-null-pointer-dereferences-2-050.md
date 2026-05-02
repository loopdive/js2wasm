---
id: 656
title: "Null pointer dereferences (2,050 FAIL)"
status: done
created: 2026-03-20
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: core-semantics
depends_on: [647]
test262_fail: 2050
files:
  src/codegen/expressions.ts:
    breaking:
      - "add null guards before struct.get in more codepaths"
---
# #656 — Null pointer dereferences (2,050 FAIL)

## Status: open

2,050 tests fail with null pointer deref. Up from 1,513 (more tests attempted). #647 fixed destructuring params but many more codepaths access struct fields on potentially-null references.

### Top patterns
- Property access on optional/undefined params
- Method calls on possibly-null class instances
- Iterator results that could be null

## Complexity: M
