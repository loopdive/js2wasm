---
id: 626
title: "Wasm call/call_ref type mismatch (378 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
goal: compilable
required_by: [659]
test262_ce: 378
files:
  src/codegen/expressions.ts:
    breaking:
      - "call/call_ref argument types don't match function signature"
---
# #626 — Wasm call/call_ref type mismatch (378 CE)

## Status: review

378 tests fail with Wasm validation: call or call_ref arguments don't match the expected function signature. Arguments are the wrong type (externref vs f64, i32 vs ref).

### Fix
Ensure argument coercion before call instructions, especially for any-typed parameters calling typed functions.

## Complexity: M
