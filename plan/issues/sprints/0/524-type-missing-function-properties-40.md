---
id: 524
title: "Type '{}' missing Function properties (40 CE)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: contributor-readiness
test262_ce: 40
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "type mapping — Function type should not require apply/call/bind properties"
---
# #524 — Type '{}' missing Function properties (40 CE)

## Status: open

40 tests fail with "Type '{}' is missing the following properties from type 'Function': apply, call, bind, prototype". The compiler maps a plain object to a Function type context but the type system rejects it.

Likely a type mapping issue where anonymous functions or callbacks are typed as `{}` instead of a proper function type.

## Complexity: XS
