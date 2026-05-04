# Sprint 16

**Date**: 2026-03-21
**Goal**: Error classification, type coercion, equivalence tests
**Baseline**: ~15,244 pass (from 03-20 evening run)

## Issues
- #695, #697 — Error classification improvements
- #702-#725 — Large batch of issues:
  - Type coercion fixes
  - Property access improvements
  - Equivalence test expansion
  - Compile error reductions

## Results
**Final numbers**: 15,232 pass / 48,097 total
**Delta**: roughly stable (±0 from baseline)

## Notes
- Test262 run at 11:53 UTC: 15,232 pass / 48,097 total
- Session state updated for next session at 16:00
- 85 commits on this date
- expressions.ts refactored (noted in session state)

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #697 | - Struct type errors for non-class structs (944 CE residual) | medium | done |
| #725 | Local HTTP server for wasm source map stack traces | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
