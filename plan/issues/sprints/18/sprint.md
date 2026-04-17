# Sprint 18

**Date**: 2026-03-22 (afternoon/evening)
**Goal**: DAG-based goal system, milestone migration, issue renumbering
**Baseline**: 14,720 pass / 48,102 total

## Issues
- #761-#767 — 7 new issues from codebase analysis
- #768-#777 — Session issues renumbered
- #763, #764 — RegExp and Symbol improvements
- #773, #776, #777 — Additional fixes

## Results
**Final numbers**: 14,720 pass / 48,102 total (stable)
**Delta**: ~0 (infrastructure/planning focused)

## Notes
- DAG-based goal system added, replacing sequential milestones
- Milestones merged into goals, plan/milestones/ removed
- Goal graph created at plan/goals/goal-graph.md
- Audit and update of all goals with session issues

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #764 | - 'immutable global' assignment error (240 CE) | low | done |
| #768 | - throwOnNull default regression: ~6400 tests fail with TypeError (null/undefined access) | critical | done |
| #776 | - 'not enough arguments on the stack for call' (362 CE) | medium | done |
| #777 | - 'immutable global' assignment error (240 CE) | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->