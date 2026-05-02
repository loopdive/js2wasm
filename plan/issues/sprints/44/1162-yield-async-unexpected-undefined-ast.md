---
id: 1162
title: "yield* async — unexpected undefined AST node in compileExpression (~161 tests)"
status: done
created: 2026-04-21
updated: 2026-04-28
completed: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
language_feature: generators
goal: spec-completeness
closed: 2026-04-23
pr: 11
net_improvement: 882
---
# #1162 — `yield*` async: undefined AST node crash (~161 tests)

## Problem

161 test262 failures in `yield-star-*` async-generator tests report:

```
unexpected undefined AST node in compileExpression
```

Sample failing tests:
- `yield-star-async-return.js`
- `yield-star-getiter-async-returns-undefined-throw.js`
- `yield-star-next-call-returns-abrupt.js`
- `yield-star-next-then-non-callable-string-fulfillpromise.js`
- `yield-star-expr-abrupt.js`

These are async generator `yield*` delegation tests — specifically the abrupt completion / error propagation paths.

## Root cause hypothesis

The `yield*` delegation codegen (`__gen_yield_star`) handles the normal iteration path but crashes when encountering certain AST shapes in the async `throw`/`return` protocol. The `compileExpression` call receives `undefined` instead of a valid AST node, suggesting a missing branch in the async-generator abrupt-completion handling.

## Investigation

1. Find `yield*` async codegen in `src/codegen/expressions.ts` or `src/codegen/generators.ts`
2. Identify where `compileExpression(undefined)` is being called — add defensive check to surface the actual missing AST node
3. Check if this is the `return` or `throw` protocol path in `yield*` delegation (§25.5.3.7)

## Acceptance criteria

- 161 `unexpected undefined AST node` errors in `yield-star-*` tests drop to 0
- `yield*` delegation with abrupt completions (throw/return) works correctly
- No regressions in async-generator equivalence tests
