---
id: 621
title: "Unsupported call expression (1,692 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: spec-completeness
test262_ce: 1692
files:
  src/codegen/expressions.ts:
    breaking:
      - "compileCallExpression doesn't handle computed method calls, super.method(), etc."
---
# #621 — Unsupported call expression (1,692 CE)

## Status: in-progress

1,692 tests fail with "Unsupported call expression" — the compiler encounters a call pattern it doesn't recognize.

### Common patterns
- Computed method calls: `obj[Symbol.iterator]()`
- Super method calls in computed property context
- Tagged template calls on member expressions
- Indirect eval: `(0, eval)("code")`

### Fix
Extend compileCallExpression to handle more call patterns. Each sub-pattern may need its own handler.

## Complexity: M
