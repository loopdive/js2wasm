---
id: 135
title: "Ternary/conditional returning non-boolean values"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-11
goal: core-semantics
---
# #135 — Ternary/conditional returning non-boolean values

## Problem
`cond ? "a" : "b"` with non-numeric return types fails. The ternary always produces the type of the numeric context, but should produce the actual type of the branches.

## Scope
- `cond ? stringA : stringB` → should return externref (string)
- `cond ? objA : objB` → should return ref type
- `cond ? 1 : "fallback"` → mixed types, needs common type

## Implementation
- In `compileConditionalExpression`, determine the result type from both branches
- Use `if/else` block with the correct result type
- For same-type branches: straightforward
- For mixed types: coerce both to a common type (externref as fallback)

## Tests blocked
~80 test262 tests

## Complexity: S
