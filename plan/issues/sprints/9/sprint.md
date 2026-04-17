# Sprint 9

**Date**: 2026-03-17
**Goal**: Async/await, for-in, try-catch, class features, prototype chain
**Baseline**: building on Sprint 8

## Issues
- #408-#448 — Large batch of compiler fixes including:
  - #408-#412 — Async/await compilation improvements
  - #413-#416 — For-in loop enhancements
  - #417-#420 — Try-catch-finally edge cases
  - #421-#423 — Class method and field fixes
  - #425, #427-#436 — Various operator and expression fixes
  - #438 — Additional fixes
  - #441 — Additional fixes
  - #444-#448 — Additional runtime improvements
  - #455 — React scheduler (started)
  - #458-#461 — Additional issues

## Results
**Final numbers**: no test262 run recorded for this date
**Delta**: 39 issues touched

## Notes
- 141 commits on this date — very high activity
- React scheduler work (#455) started
- Transition period between systematic sprints and large session-based work

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #408 | Compiler hangs on for-of with Set mutation during iteration | high | done |
| #412 | Yield outside generator -- generator function body not recognized | medium | done |
| #413 | Parameter self-reference -- default param validation too strict | medium | done |
| #416 | Compound assignment on element access (non-ref targets) | medium | done |
| #417 | Wrong return value (returned 0) -- broad runtime correctness failures | critical | done |
| #420 | Cannot destructure non-array types (34 CE) | medium | done |
| #421 | Array.reduce requires callback and initial value (23 CE) | medium | done |
| #423 | Invalid field index in struct access (36 CE) | medium | done |
| #425 | Async/yield keyword parsing edge cases (12 CE) | low | done |
| #427 | SuperKeyword unsupported in remaining contexts (11 CE) | low | done |
| #436 | for-of array destructuring: element is not a ref type (42 CE) | medium | done |
| #438 | Internal error: Cannot read properties of undefined in expression compilation (20 CE) | medium | done |
| #444 | Wasm validation: local.set type mismatch (292 CE) | high | done |
| #448 | Wasm validation: type mismatch i32 expected (47 CE) | medium | done |
| #458 | Map/Set via host imports | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->