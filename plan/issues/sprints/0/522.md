---
id: 522
title: "Object.keys() requires struct type argument (43 CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: contributor-readiness
test262_ce: 43
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "Object.keys — accept non-struct arguments (externref, any)"
---
# #522 — Object.keys() requires struct type argument (43 CE)

## Status: in-progress

43 tests fail because `Object.keys(obj)` rejects non-struct arguments. The type check is too strict — it should accept `any`/`externref` typed objects and fall back to runtime enumeration or return empty array.

## Complexity: XS
