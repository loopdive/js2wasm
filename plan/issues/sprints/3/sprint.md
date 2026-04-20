# Sprint 3

**Date**: 2026-03-11 (evening)
**Goal**: Zero runtime failures, ~1,500 CE reduction
**Baseline**: ~1,509 pass

## Issues
- #225, #245 — String comparison in equality ops and switch statements
- #226, #248 — valueOf coercion on object literal comparisons, logical op tests
- #227, #228 — BigInt comparison/equality with Number and Infinity
- #231, #253 — Remove overly broad typeof and loose inequality skip filters
- #233, #256 — Nested function hoisting in loops/switch
- #236, #240 — Super/derived-class diagnostic suppression
- #244 — In operator runtime failures
- #246 — Missing struct fields in for-of object destructuring
- #247 — Null/undefined arithmetic correct results
- #251, #252, #255 — Equivalence tests
- #254 — Private class field assignment diagnostic suppression

## Results
**Final numbers**: merged same session, incremental improvements
**Delta**: 13 issues marked done

## Notes
- Sprint 3 issue specs and plan committed at 2026-03-11 17:51
- Consolidation merge at 18:13 with 11 issues in one commit
- Created Sprint 4 & 5 issues (#257-#316) at end of sprint

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #225 | Issue #225: For-loop continue/break with string !== comparison |  | done |
| #226 | Issue #226: valueOf/toString coercion on comparison operators |  | done |
| #231 | Issue #231: Member expression property assignment on empty objects (escaped identifiers) |  | done |
| #233 | Issue #233: Unknown identifier from destructuring in catch/for-of patterns |  | done |
| #236 | Issue #236: allowJs type flexibility -- boolean/void/string as function arguments |  | done |
| #240 | Issue #240: Setter return value -- allow return in setter bodies |  | done |
| #245 | Issue #245: Switch statement with string case values |  | done |
| #246 | Issue #246: For-of object destructuring -- TypeError on primitive coercion |  | done |
| #247 | Issue #247: Arithmetic with null/undefined produces wrong results |  | done |
| #248 | Issue #248: Logical operators with object operands returning wrong values |  | done |
| #251 | Issue #251: super() call required in derived class constructors |  | done |
| #252 | Issue #252: Subsequent variable declarations type mismatch (var re-declaration) |  | done |
| #253 | Issue #253: Narrow skip filters -- typeof string comparison, loose inequality |  | done |
| #255 | Issue #255: 'this' implicit any type in class methods |  | done |
| #256 | Issue #256: Unknown function: f -- locally declared functions not found |  | done |

<!-- GENERATED_ISSUE_TABLES_END -->
