---
sprint: 50
date: 2026-05-07
author: product-owner
---

# Sprint 50 — Planning Discussion

This is the living record of how Sprint 50's backlog was shaped: what was
validated, who proposed what, and why each call was made. Update inline as
the sprint progresses.

## Inputs

- **Today**: 2026-05-07. Fresh weekly token budget.
- **Sprint 49** active since 2026-05-03 (4 days). 6 done, 3 marked
  in-progress (2 of which were already merged but had stale status), 8
  ready/deferred.
- **test262 baseline**: 27,769 / 48,171 pass (57.7%); 17,784 fail; 1,015 CE;
  86 CT.
- **Open PR**: #207 (`fix-differential-cache-key`) — CI-only fix.

## Validation pass (PO smoke-tests)

### S49 in-progress issues

| ID | Claimed status | Reality | Action |
|----|---------------|---------|--------|
| #1126 | in-progress (high) | Stages 1+2 merged via PR #205 + #206. Stages 3-6 remain (architect spec exists in issue file). Carry forward. | Keep open; route Stage 3 as **senior dev** task. |
| #1301 | in-progress (med) | **Already merged via PR #216** (commits `94c7da76e`, `74f5bc04b`, `01985561a`, `ba9ba9e2c`). Findings + acceptance status documented. | Close as `done`, completed 2026-05-04. |
| #1304 | in-progress (med) | **Already merged via PR #219** (commits `07e94d9ef`, `5ee762b95`). Root cause + acceptance fully documented. | Close as `done`, completed 2026-05-04. |

**Decision (PO)**: Update `#1301` and `#1304` to `status: done` immediately —
the sprint board was misreporting two real wins as still-open. Done in
this session.

### S49 ready issues — feasibility check

| ID | Validated approach | Routing notes |
|----|-------------------|---------------|
| #1298 | Root cause is documented (call-site doesn't unbox `__fn_wrap_N_struct` externref before call_ref). High value: blocks idiomatic Hono / koa middleware AND lodash Tier 2 dispatch. **Hard / high** — needs **architect spec** before dispatch. | Route to architect first. |
| #1306 | Sibling of #1301 (same file `calls.ts`). End-to-end runtime gap: `mws[idx](c, next)` on closure-typed array compiles to `ref.null; drop`. Likely the SAME fix path as #1298. | Pair with #1298 on the architect's desk; one spec may cover both. |
| #1302 | Suspended-work notes exist in `worktree issue-1302-flow-global-idx`: 212 imported globals + 46 declared = 258 total, but `__closure_837` references indices 258–266. Late closure emission outruns declared global count. Concrete starting state. | Resume in existing worktree. Medium effort. |
| #1303 | f64.trunc on externref in lodash `partial.js mergeData`. IR side fix landed; legacy path is the gap. Pair with #1305. | Standalone medium task. |
| #1305 | Module-level `var X = N` legacy global typing fix; hard but well-scoped. Two-layer fix proposed in issue (defensive + root cause). | Route after / together with #1303. |
| #1292 | Stress-test harness landed; tier 2b/2c/2d-call cases skip pending #1302/#1303/#1305/#1304. With #1304 done, only Tier 2b/2c/2d remain skipped. Un-skip work after blockers land. | Tail-end task; assign to whoever lands the last blocker. |
| #1223 | Deferred since S47. Hard. Niche TDZ async/gen sharing across destructure-assign LHS. Low payoff per effort. | Park; only pull in if capacity surplus and senior dev free. |
| #1199 | Deferred since S48. Hard, performance-only. | Park to backlog. |

## Sprint 49 closure decision

**PO recommendation**: **Close S49, open S50.**

- S49 has a clean exit point: 6 issues genuinely done; the two stale
  in-progress entries are now corrected to done.
- Fresh weekly budget warrants a fresh sprint with a coherent theme.
- Carry-over set is clearly thematic (closure/call dispatch
  correctness + #1126 Stage 3) which makes a clean S50 banner.

## Sprint 50 theme

> **Closure / call dispatch correctness wave 2 — finish lodash Tier 2,
> land Hono Tier 5c, and move #1126 IR through Stage 3 emitter integration.**

This is the natural follow-on to S49: two Tier 5 lodash failures and
one Tier 5 Hono failure are blocked on closely-related closure /
call-dispatch bugs. Closing this cluster unblocks the npm-library-
support goal across Hono, koa, and lodash partial / flow / negate
patterns at once.

In parallel, #1126 Stage 3 (the architect-spec'd IR emitter
integration, the largest stage of the integer-domain inference pass)
gets a dedicated senior slot.

## Prioritized sprint backlog (proposed)

Ordered by **value (impact × unblocking potential)**, not raw
fail-count:

| Order | Issue | Title | Priority | Feasibility | Routing |
|-------|-------|-------|----------|-------------|---------|
| 1 | #1298 | Function-typed field/array/Map call drops & returns null | **high** | hard | Architect-spec required before dispatch. Likely covers #1306 in the same fix. |
| 2 | #1306 | `mws[idx](c, next)` on closure-typed array drops to ref.null | medium | medium | Pair with #1298 architect spec; if same fix, fold in. |
| 3 | #1126 (Stage 3) | IR emitter integration for i32/u32 lattice | **high** | hard | Senior dev. Architect spec already in issue file (Stages 1-6 fully decomposed). |
| 4 | #1302 | lodash flow.js `__closure_837` invalid global index | medium | medium | Resume in `worktree issue-1302-flow-global-idx`. Suspended-work notes are concrete. |
| 5 | #1303 | lodash partial.js `mergeData` f64.trunc on externref (legacy) | medium | medium | Standalone. |
| 6 | #1305 | Module-level `var X = N` externref leak into bitwise legacy path | medium | hard | Pair with #1303 (same file, same gap layer). May be one PR. |
| 7 | #1292 | lodash Tier 2 — un-skip Tier 2b/2c/2d after blockers land | medium | low | Tail-end. Whoever lands the last blocker un-skips and confirms green. |
| 8 | #1223 | TDZ async/gen writer+reader fn-decl sharing | medium | hard | Parking lot. Pull only if all higher items land and senior dev is idle. |

**Capacity guidance**: 8 active items is more than 3 dev slots can carry
in a week. Treat #1-#6 as the **committed** sprint scope; #7-#8 as
stretch. #1126 Stage 3 (#3) is a 500-LoC senior task that will
dominate one slot for most of the sprint.

## Routing & specs needed before dispatch

| Issue | Architect spec needed? | Notes |
|-------|------------------------|-------|
| #1298 | **Yes** | Root cause is documented; spec needs to nail the call-site detection logic (when is the loaded externref a `__fn_wrap_N_struct`?) and the unbox/cast/call_ref sequence. Hard codegen change. |
| #1306 | Probably bundled with #1298 | Architect should verify whether the element-access call dispatch shares the missing-unbox path. |
| #1126 Stage 3 | Already specified | Senior-developer architect spec already in issue file (lines 282-331). Ready to dispatch. |
| #1305 | Already specified | Two-layer plan in issue file. Either layer is dev-actionable. |
| #1302, #1303 | No | Concrete repro + investigation pointers. Standard medium tasks. |

## New issues to seed (PO scan)

No net-new issues from a backlog scan today. The lodash Tier 2 cluster
captured all the recent failure modes (#1298, #1301, #1302, #1303,
#1304, #1305, #1306). Once those land, the next cluster will surface
from un-skipping Tier 2 fully and pushing into Hono Tier 6 / a Tier 3
lodash exploration.

**One housekeeping note**: #1199 and #1126 are duplicated in
`plan/issues/backlog/` and `plan/issues/sprints/49/`. Tech lead to dedupe
when wrapping S49 — the sprint copy is the authoritative one.

## Dispatch order recommendation

When tech lead populates the TaskList:

1. Send #1298 + #1306 to the **architect** for a shared spec (they
   touch the same file and may share a fix).
2. Dispatch #1126 Stage 3 to **senior-developer** immediately
   (architect spec already present).
3. Dispatch #1302 to a dev — resume existing worktree.
4. Dispatch #1303 + #1305 as a paired senior task once #1303 is
   scoped, OR split them after #1303 lands.
5. Tail: #1292 un-skip work to whichever dev lands the last blocker.
6. #1223 stays parked; revisit at mid-sprint check-in.

## Definition of done for Sprint 50

- #1298 + #1306 merged → Hono Tier 5c "two middlewares run in
  registration order" passes without skip; idiomatic
  `app.get('/path', c => c.text(...))` dispatches.
- #1302 + #1303 + #1305 merged → `compileProject('lodash-es/flow.js')`
  and `'lodash-es/partial.js'` both produce binaries that pass
  `new WebAssembly.Module(...)`.
- #1292 Tier 2b/2c/2d skip markers removed; all four Tier 2 cases
  green.
- #1126 Stage 3 emitter integration merged; IR-claimed bitwise
  loops emit `i32.{and,or,xor,shl,shr_s,shr_u}` directly. #1236
  saturation canary stays green.
- test262 net delta ≥ 0 on each merge; no single regression
  bucket > 50.

## Open questions for tech lead

1. Is the senior dev (Opus tier) available for #1126 Stage 3 + #1298
   architect spec, or do we need to sequence them?
2. Should we attempt #1223 as a stretch? It's been deferred 3 sprints;
   either commit or move to backlog and stop carrying it.
3. Confirm dedupe of #1126 / #1199 between `sprints/49/` and `backlog/`
   directories during the S49 close.
