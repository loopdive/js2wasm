---
id: 43
status: done
---

# Sprint 43

**Date**: 2026-04-20 → 2026-04-23
**Starting baseline**: inherited from sprint 42
**Ending baseline**: 24,483 / 43,172 = 56.7% (unchanged — IR work is infrastructure, not test262 coverage)

## Carry-over from Sprint 42

All issues below were not started in sprint 42 and carried over. Issues with open PRs from sprint 42 remain in sprint 42 until merged.

## Issues

**Top priority**: #1131 — Middle-end SSA IR: implementation plan (phase 2 of #1124 audit)

<!-- populated from plan/issues/sprints/43/*.md -->

## Results

**3 PRs merged:**
- **PR #160** — #1076 CI merge split (merge-report + regression-gate jobs separated)
- **PR #231** — #1131 IR Phase 1 (SSA IR scaffold: nodes, builder, verify, emit stubs)
- **PR #258** — #1131 IR Phase 2 (interprocedural type propagation + call support)

**2 issues completed** (from issue tables): #826 illegal cast residuals, #1127 nested rest patterns

**Baseline held at 24,483** — IR phases are infrastructure; no new test262 coverage expected until IR path handles real workloads (#1168+).

**Most sprint 43 spec issues not reached** — #1152, #1160, #1161, #1162, #1163 and all IR Phase 3 work (#1167a/b/c, #1168) carried to sprint 44.

**Sprint 43 was short** (~3 days) and strategic: it laid the entire IR middle-end foundation that sprint 44's production-readiness work depends on.

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1131 | Middle-end SSA IR: implementation plan | high | ready |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #826 | Illegal cast failures (1,276 runtime failures) | high | done |
| #1127 | Class method param destructuring: nested array pattern + initializer throws spurious TypeError | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
