---
agent: product-owner
session: 2026-04-30 sprint 46 planning
status: planning complete, sprint dispatched
---

# Product Owner — Sprint 46 planning session (2026-04-30)

## Session goal

Plan sprint 46 with the project lead. Sprint 45 closed at
25,830 / 43,168 = 59.8% pass rate.

## Decisions made

**Sprint theme: C-then-A.** Project lead chose:
1. Phase 1 = Theme C (benchmark & visibility cleanup) first
2. Phase 2 = Theme A (conformance progress) second
3. Theme B (credibility — #1201, #1203, #1204, #1190) deferred to S47
4. #1126 (JS number → int32/uint32 inference) deferred to S47 — too
   broad, competes with #1205 for senior-dev attention

**Capacity:** 4 devs + 1 architect (architect spawned by tech lead in
parallel with PO setup).

## Housekeeping completed

  - **#1080 closed** — moved to `plan/issues/sprints/45/1080.md`
    with `status: done`, `completed: 2026-04-29`. All four children
    (#1076–#1079) shipped in S45; umbrella scope met. Closure note
    added.
  - **#1126 deferred** — moved to `plan/issues/backlog/1126.md` with
    `sprint: 47`, `status: ready`. Deferral note added.
  - **Sprint 46 doc rewritten** — `plan/issues/sprints/46/sprint.md`
    now reflects the actual S46 plan. Old narrative referenced 5
    issues that all shipped in S45 (#1185, #1186, #1169f, #1169g,
    #1169h) so it had to be replaced.

## Dev TaskList (queued for the 4 devs)

**Phase 1 (C):**
  - Task #6 — #1188 custom domain (any dev, easy)
  - Task #7 — #1209 + #1211 labs hosted bundle (any dev, easy/medium)
  - Task #8 — #1187 test-runtime helper (any dev, easy/medium)
  - Task #9 — #1210 string-hash GC (senior, blocked on architect spec)

**Phase 2 (A):**
  - Task #10 — #1169j TypedArray IR slice (any dev, easy)
  - Task #11 — #1169k ArrayBuffer/DataView IR slice (any dev, easy)
  - Task #12 — #1169l Date/Error/Map/Set IR slice (any dev, easy)
  - Task #13 — #1205 TDZ async/gen (senior, blocked on architect spec)
  - Task #14 — #1177 TDZ re-attempt (any dev, blockedBy: task #13)
  - Task #15 — #1169m Promise IR slice (stretch)

## Architect spec requests filed

Two specs gating dispatch:

  1. **#1210 string-hash GC pressure** — pick Option A (pre-alloc
     buffer detection — PO recommendation), B (rope), or C (defer).
     Detection criteria for `let s = ""; for (...) s += c` patterns.
  2. **#1205 TDZ flag boxing for async/gen** — validate the issue's
     existing strategy (lines 91-126) against post-slice-7 generator
     IR shape. Identify capture-prepend sites in
     `src/ir/from-ast.ts:liftAsyncFunction`.

## What's left for the next PO session

When PO is respawned for S46 acceptance / S47 grooming:

  - **Accept/reject completed work** as PRs land. Verify acceptance
    criteria per issue file.
  - **S47 grooming** when S46 closes — Theme B (#1201, #1203, #1204,
    #1190) and #1126 are pre-positioned.
  - **#1177 acceptance** — special attention. Re-attempt depends on
    #1205 landing first; verify the 63 for-await-of regressions
    actually retire (not just net pass).
  - **#1210 acceptance** — verify the string-hash benchmark hits
    target (< 2000ms in wasmtime, vs current 20s timeout).

## Files of record

  - `plan/issues/sprints/46/sprint.md` — sprint plan and dispatch
    ordering (rewritten this session)
  - `plan/issues/sprints/45/1080.md` — closed umbrella, moved here
  - `plan/issues/backlog/1126.md` — deferred to S47
  - `plan/log/retrospectives/sprint-45.md` — S45 retro (read for
    context on #1177 revert and #1205 origin)

## Open questions for project lead (next session)

  - When S46 closes, should #1190 (CI baseline drift research) be
    bundled with Theme B for S47, or split off as a standalone CI
    sprint? It overlaps thematically with #1201 (per-path scores
    feed CI dashboards) but is its own concern.
  - When does #1169 umbrella close? Slice 10 steps B-E land in S46;
    legacy `expressions.ts` / `statements.ts` removal is S47+ work.
    Worth a planning note for S47 about the umbrella retirement
    criteria.
