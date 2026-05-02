---
id: 188
title: "`instanceof` operator: 20 compile errors"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: class-system
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileInstanceOf: extend to map class types to wasm struct types for ref.test"
---
# #188 — `instanceof` operator: 20 compile errors

## Status: backlog

## Summary
All 20 non-skipped `instanceof` tests fail to compile. The `instanceof` operator is not implemented or incomplete in the codegen.

## Motivation
20 test262 compile errors in `language/expressions/instanceof` with 0 passes. `instanceof` checks if an object is an instance of a class constructor. In wasm-gc, this maps to `ref.test` with the appropriate struct type.

## Scope
- `src/codegen/expressions.ts` — BinaryExpression for `instanceof`
- Need to map class types to wasm struct types for ref.test

## Complexity
M

## Acceptance criteria
- [ ] `obj instanceof MyClass` produces correct boolean result
- [ ] 10+ test262 instanceof compile errors fixed
