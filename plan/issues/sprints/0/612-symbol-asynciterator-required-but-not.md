---
id: 612
title: "Symbol.asyncIterator required but not implemented (367+ CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: iterator-protocol
test262_ce: 367
files:
  src/codegen/expressions.ts:
    new:
      - "Symbol.asyncIterator support as compile-time struct field"
    breaking: []
---
# #612 — Symbol.asyncIterator required but not implemented (367+ CE)

## Status: open

367 tests fail with "Type '{}' must have a '[Symbol.asyncIterator]()' method that returns an async iterator." Plus 51 tests with "Type '{ readonly [Symbol.iterator]: void; readonly [Symbol.asyncIterator]: void; }'" errors.

These are async generator tests that use `for await (... of ...)` on objects with async iterator protocol.

### Root cause

The compiler recognizes `Symbol.iterator` (#481 done) but not `Symbol.asyncIterator`. Async iteration (`for await...of`) requires the `[Symbol.asyncIterator]()` protocol method.

### Fix

Same pattern as #481: compile `[Symbol.asyncIterator]` as a reserved struct field `__symbol_asyncIterator`. For `for await...of`, call the async iterator method and handle the `{ value, done }` protocol.

## Complexity: M
