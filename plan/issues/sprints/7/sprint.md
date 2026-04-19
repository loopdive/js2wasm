# Sprint 7

**Date**: 2026-03-13 (continued)
**Goal**: Runtime failure patterns — null guards, skip filter cleanup, gap coverage
**Baseline**: building on Sprint 6

## Issues
- #324 — Runtime test failures with wrong return values
- #325, #326 — Array rest destructuring null deref, bounds checking
- #327 — Object-to-primitive coercion for increment/decrement
- #328 — OmittedExpression for array holes/elision
- #330 — ClassExpression in assignment positions
- #331 — Suppress strict mode eval/arguments diagnostics
- #332 — Skip _FIXTURE helper files in test262
- #334 — Private class fields/methods and accessor compound assignment
- #335 — Track bracket/brace depth in stripThirdArg/stripUndefinedAssert
- #336 — for-of object destructuring on non-struct refs
- #337 — Null guards to runtime property/element access
- #338 — Negative test support in test262 runner
- #341 — Property introspection (hasOwnProperty, propertyIsEnumerable)
- #342 — Array.prototype.method.call/apply patterns
- #344 — Wrapper constructors new Number/String/Boolean
- #347 — Function/class .name property completion
- #348 — Null/undefined arithmetic coercion
- #349 — String() constructor as function
- #352 — Delete operator expression
- #355 — Object.keys with numeric-string keys
- #357 — IIFE and call expression tagged templates
- #358-#386 — 29 gap issues for complete test262 coverage
- #361 — Runtime `in` operator for array index bounds
- #362 — typeof on member expressions
- #367 — Remove overly broad string concatenation skip filter
- #368, #369 — `this` in global scope, globalThis identifier
- #375 — super.method() and super.prop in class methods
- #377 — Getter/setter accessor edge cases
- #378 — Graceful fallback for inc/dec on unresolvable access
- #379 — Tuple/destructuring type errors
- #380 — Graceful fallback for unknown variables/functions
- #381 — Downgrade "never nullish" diagnostic
- #382 — Spread argument in super/function calls
- #385 — Array method optional args

## Results
**Final numbers**: ~6,366 pass (first test262 run recorded at end of day)
**Delta**: Major jump from skip filter cleanup and new test categories

## Notes
- Created 29 gap issues (#358-#386) for systematic test262 coverage
- First recorded test262 run at 2026-03-18 21:35 shows 6,366 pass
- This sprint + Sprint 6 represent the most productive 24 hours of the project

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #324 | - Runtime test failures (wrong return values) | high | done |
| #325 | - Null pointer dereference at runtime | medium | done |
| #326 | - Array element access out of bounds | medium | done |
| #327 | - Object-to-primitive coercion (valueOf/toString) | medium | done |
| #328 | - OmittedExpression (array holes/elision) | low | done |
| #330 | - ClassExpression in unsupported positions | medium | done |
| #332 | - Export declaration at top level errors | low | done |
| #334 | - Private class fields and methods | medium | done |
| #335 | - Parser comma errors (non-computed-property contexts) | medium | done |
| #336 | - For-of assignment destructuring on non-struct refs | medium | done |
| #338 | - Negative test support in test262 runner | high | done |
| #341 | - Property introspection (hasOwnProperty, propertyIsEnumerable) | medium | done |
| #342 | - Array.prototype.method.call/apply patterns | medium | done |
| #347 | - Function/class .name property completion | high | done |
| #348 | - Null/undefined arithmetic coercion | high | done |
| #349 | - String() constructor as function | medium | done |
| #352 | - Delete operator | low | done |
| #355 | - Object.keys/values/entries completion | medium | done |
| #367 | - String variable concatenation in comparisons | low | done |
| #368 | - Global/arrow `this` reference | low | done |
| #369 | - globalThis support | low | done |
| #377 | - Getter/setter accessor edge cases | low | done |
| #378 | - Increment/decrement on property/element access | medium | done |
| #379 | - Tuple/destructuring type errors | medium | done |
| #380 | - Unknown variable/function in test scope | medium | done |
| #381 | - Nullish coalescing false positives | low | done |
| #382 | - Spread argument in super/function calls | low | done |
| #385 | - Array method argument count errors | low | done |
| #386 | - Remaining small CE patterns | low | done |

<!-- GENERATED_ISSUE_TABLES_END -->