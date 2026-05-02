---
id: 619
title: "Residual undefined .kind crashes after null guard (4,230 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
goal: compilable
required_by: [646]
---
# Issue #619: Residual undefined .kind crashes after null guard

## Problem
4,230 tests hit the null guard added in #611 -- the AST node IS undefined. The guard prevents crashes but tests still CE. The root cause is missing AST node handlers for class elements that flow through `compileStatement` and `compileExpression`.

## Root Cause
Class member nodes (`PropertyDeclaration`, `SemicolonClassElement`, `ClassStaticBlockDeclaration`, `PrivateIdentifier`) are not handled in the statement/expression compilers. When they leak into these compilers (e.g., from iterating class body members), they hit the "Unsupported statement/expression" error path.

## Solution
Added handlers in `compileStatementInner` (statements.ts) for:
- `PropertyDeclaration` -- no-op (field initializers handled in `compileClassBodies`)
- `SemicolonClassElement` -- no-op (stray `;` in class body)
- `ClassStaticBlockDeclaration` -- compile the contained statements

Added handler in `compileExpression` (expressions.ts) for:
- `PrivateIdentifier` -- emit `i32.const 1` (truthy sentinel for `#x in obj` pattern)

Also added `PrivateIdentifier` recognition in the `in` operator's key resolution for `#field in obj` patterns.

## Implementation Summary
- **statements.ts**: Added 3 new handlers before the "Unsupported statement" fallback
- **expressions.ts**: Added `PrivateIdentifier` handler before `SuperKeyword`, and private field recognition in `InKeyword` handling
- **tests/class-elements-619.test.ts**: 6 tests covering field declarations, private fields, semicolons, expression initializers, no-initializer properties, and static+instance fields
- All 6 new tests pass; no regressions in existing class tests
