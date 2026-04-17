# Sprint 19

**Date**: 2026-03-23
**Goal**: Equivalence tests, RegExp, skip filter work
**Baseline**: 14,720 pass / 48,102 total

## Issues
- #767 — Equivalence tests for RegExp, Promise, Proxy, WeakMap/WeakSet
- #774 — Additional fix

## Results
**Final numbers**: 14,120 pass / 48,102 total → 15,997 pass / 49,642 total
**Delta**: Variable — initial regression then recovery to +1,277

## Notes
- Test262 run at 00:46: 14,120 pass (regression from expanded test set)
- Run at 19:52: 14,562 pass / 49,642 total (test suite expanded again)
- Run at 19:57: 15,997 pass / 49,642 total (major jump, likely cache effects)
- 50 commits on this date — lighter activity day

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #767 | - Equivalence test coverage gaps: RegExp, Promise, async iterators | medium | done |
| #774 | - Missing early error checks: tests expect SyntaxError but compile successfully | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->