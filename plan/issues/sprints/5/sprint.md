# Sprint 5

**Date**: 2026-03-12
**Goal**: Deep runtime fixes — coercion, equality, assignment, instanceof
**Baseline**: building on Sprint 4

## Issues
- #178 — Resolve Wasm validation errors for type mismatches
- #234, #235 — ClassDeclaration in nested positions, Function.name
- #238, #239 — Named class expressions, bracket notation field resolution
- #250 — Function declarations inside for-loop bodies
- #260 — Preserve non-null ref type in conditional expressions
- #274 — Function .name property access
- #289 — Bare identifier/assignment initializers in for-in
- #290 — instanceof with class hierarchies and expression operands
- #292 — number_toString import for any-typed string +=
- #293 — Default parameter initialization for class constructors/methods
- #294 — Assignment expressions return RHS value
- #295, #296 — BigInt vs String comparison, strict equality cross-type
- #297 — Switch statement fall-through with default in non-last position
- #298 — Nested function mutable captures and capture param padding
- #299 — Loose equality null == undefined
- #301 — Saturating float-to-int truncation
- #302 — Math.min/max zero-argument edge cases
- #303 — parseInt edge cases
- #304 — Unary minus coercion and -0 preservation
- #306 — Prefix/postfix inc/dec on member expressions
- #308 — bigint-to-string coercion and ambiguous addition fallback
- #315 — Re-read local type after func expr update
- #317 — Lazy AnyValue type registration and deduplicate exports
- #321 — Collection functions scan top-level statements
- #322 — Inline trig/transcendental Math methods as pure Wasm

## Results
**Final numbers**: incremental improvements in runtime correctness
**Delta**: 25+ issues resolved in one session

## Notes
- Sprint 5 backlog created at 2026-03-12 05:29
- Issues #317-#323 added during sprint

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #250 | Issue #250: For-loop with function declarations (113 compile errors) | high | done |
| #290 | Issue #290: Instanceof compile errors -- class hierarchy and expressions | high | done |
| #322 | [ts2wasm] Inline trig/transcendental Math methods as pure Wasm | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
