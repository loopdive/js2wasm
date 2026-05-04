---
id: 735
title: "- Async iteration correctness (329 tests)"
status: blocked
created: 2026-03-22
updated: 2026-04-28
priority: medium
feasibility: hard
goal: async-model
depends_on: [680, 681]
test262_fail: 329
files:
  src/codegen/statements.ts:
    breaking:
      - "for-await-of codegen"
  src/codegen/expressions.ts:
    breaking:
      - "async generator functions"
---
# #735 -- Async iteration correctness (329 tests)

## Status: backlog

## Problem

329 test262 tests related to async iteration fail with assertion errors:
- language/statements/for-await-of: 146 tests
- language/expressions/async-generator: 102 tests
- language/statements/async-generator: 39 tests
- language/expressions/async-function: 11 tests
- Other async patterns: 31 tests

### What needs to happen

1. Depends on #680 (pure Wasm generators) and #681 (pure Wasm iterators) -- async generators build on both
2. `for-await-of` must properly await each iterator result
3. Async generator `yield` must produce promises
4. Error propagation through async iteration chain

## Complexity: L (>400 lines, builds on generator + iterator + async)
