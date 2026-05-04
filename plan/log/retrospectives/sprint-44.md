---
sprint: Sprint-44
status: closed
session_end: 2026-04-24
---

# Sprint 44 Retrospective

**Duration:** 2026-04-22 → 2026-04-24 (2 days)
**Sprint count:** 44 sprints total

## Numbers

| Metric | Sprint start | Sprint end |
|--------|--------------|------------|
| test262 pass | 24,483 | **25,276** |
| pass rate | 56.7% | **58.6%** |
| Net gain | — | **+793** |
| Total tests | 43,172 | 43,172 |

## What shipped

| PR | Issue | Description | +Tests |
|---|---|---|---|
| #246 | #1153 | Compiler crash (prototype poisoning) | +2,351 |
| #247 | #1152 | Array.prototype higher-order regression | +624 |
| #250 | #1156 | Array.prototype numeric init | +2,739 |
| #243 | #1150 | Async destructuring regressions | +262 |
| #241 | #1149 | null_deref in eval-code methods | +57 |
| #240 | #1148 | skip:103 regression (Annex B eval-code) | +21 |
| #145 | #825 | Null dereference failures | +38 |
| #7  | #1160 | Array.from prototype poisoning | +578 |
| #8  | #1163 | Static eval inlining | +491 |
| #11 | #1162 | yield* async undefined AST crash | +882 |
| #12 | #1161 | Destructure null/undefined in private params | +396 |
| #5  | #1168 | IR frontend widening (IrType, LatticeType) | 0 (IR gated) |
| #6  | #1167a | IR hygiene passes (CF+DCE+simplifyCFG) | 0 (IR gated) |
| #9  | #1167b | IR inline-small pass | 0 (IR gated) |
| #13 | #1167c | IR monomorphize + tagged-unions | 0 (IR gated) |

**IR Phase 3 complete.** The full SSA IR optimization pipeline (3a + 3b + 3c) landed this sprint.
IR path gated behind `isPhase1Expr` — test gains will materialize when Phase 4 (#1169) migrates
the full compiler.

## What went well

1. **IR Phase 3 completed on schedule.** All four IR PRs (#5, #6, #9, #13) landed cleanly within
   the 2-day sprint window. Phase 4 (#1169) is now unblocked.

2. **High-impact spec fixes landed without regressions.** #1153 (+2,351), #1156 (+2,739), and
   #1162 (+882) were large-yield PRs with zero net regressions — clean CI runs straight through.

3. **Self-merge discipline held.** Devs self-merged PRs via `.claude/ci-status/` monitoring
   without tech-lead bottleneck. The merge queue cleared smoothly across 13 PRs.

4. **Sprint scope control (second triage).** Sprint 44 had originally inherited 74 issues from
   sprint 43. A re-triage on 2026-04-23 cut it to 21 actionable issues, keeping the sprint
   focused and completable.

5. **Correction commit landed the same session.** The +8,439 miscalculation (naive per-PR delta
   sum) was caught and corrected before sprint close — the fix-commit `b5406d677` documents the
   correct methodology for future reference.

## What went badly

1. **LFS budget exhausted mid-sprint.** The baseline-promotion CI job (`chore(test262): refresh
   sharded baseline`) failed when GitHub LFS quota was exhausted. The workaround — adding
   `continue-on-error: true` to the LFS step — let CI continue, but it means baseline files may
   be missing from the LFS store. Root cause: large `*.jsonl` baseline files accumulated over
   many sprints without LFS quota monitoring. Issue #1078 covers the permanent fix.

2. **Sprint inflated to 74 issues.** Sprint 44 inherited the full overflow from sprint 43 (55
   issues) plus new work. At 74 issues, planning became unwieldy and a second triage was needed
   mid-sprint. The 55 carried-over issues added noise to the task list without adding value.

3. **IR Phase 3 contributed 0 direct test gains.** Four IR PRs merged cleanly but show zero
   conformance improvement because the IR path is still gated. This is expected infrastructure
   work, but it means 4 dev-sprint slots bought 0 visible progress for end users.

4. **+8,439 miscalculation in initial sprint-close commit.** Per-PR `snapshot_delta` values were
   naively summed, producing a grossly inflated figure. Required a correction commit. The correct
   methodology (final_count − sprint_start_baseline) was documented but not applied initially.

## Action items

- [ ] **Cap sprint size at ~25 issues.** Sprint 44's 74-issue list required a second mid-sprint
  triage. Future sprint planning should hard-cap at ~25 issues at sprint creation time. If
  overflow exists, open it as sprint N+1 immediately. *(Propose to PO for sprint 45 planning.)*

- [ ] **Add LFS quota check to sprint-wrap-up checklist.** Before each sprint's baseline
  promotion step, confirm `git lfs env` shows adequate quota. If <20% remaining, open an issue
  to clean up old LFS objects before the sprint starts. *(Add to `plan/method/sprint-wrap-up.md`
  or equivalent checklist.)*

- [ ] **Document per-PR vs. net delta distinction in sprint template.** Add a standing note in
  the sprint Results template explaining that per-PR `+Tests` figures are branch-relative and
  MUST NOT be summed. *(Add to `plan/issues/sprints/TEMPLATE.md` if it exists, or to
  developer.md.)*

- [ ] **IR Phase 4 (#1169) as sprint 45 headline.** IR gating is the highest-leverage unlock:
  completing Phase 4 will surface the gains from all 4 IR Phase 3 PRs at once. Ensure #1169 is
  sprint 45 priority 1. *(Already planned — confirm with PO at sprint 45 kickoff.)*

## Carry-overs to sprint 45

55 issues moved; see `plan/issues/sprints/45/sprint.md` for the full list. Highest priority
among them: #1169 (IR Phase 4 — unblocked by this sprint's IR work), #991–#996 (compiler
timeouts), and the CI baseline-drift hardening set (#1076–#1080).

## Sprint close criteria — met

- [x] IR Phase 3 complete (3a + 3b + 3c merged)
- [x] Baseline promoted: 24,483 → 25,276 (58.6%)
- [x] Sprint tag `sprint/44` applied
- [x] Sprint status updated to `closed`
- [x] Retrospective written
- [x] Diary updated
