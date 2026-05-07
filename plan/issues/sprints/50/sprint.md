---
id: 50
status: active
created: 2026-05-07
started: 2026-05-07
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: false
---

# Sprint 50

**Planned**: 2026-05-07 — seeded from S49 carry-over + lodash/Hono Tier 2 cluster
**Started**: 2026-05-07

## Theme

> **Closure / call dispatch correctness wave 2** — finish the lodash Tier 2 +
> Hono Tier 5c cluster, and move #1126 IR through Stage 3 (emitter
> integration).

This is a direct continuation of S49's closure-correctness work. Two
lodash Tier 2 cases (`flow.js`, `partial.js`) and one Hono Tier 5c case
(`compose: two middlewares run in registration order`) all fail on
closely related closure / call-dispatch bugs. Closing this cluster
unblocks the npm-library-support goal across koa, hono, and lodash
HOF patterns at once. In parallel, #1126 Stage 3 lands the IR-side
i32/u32 emitter that is the load-bearing perf payoff of Stages 1-6.

## Goals

1. **Closure call dispatch** — fix function-typed value calls when the
   value is loaded from a field, array element, or Map value (#1298,
   #1306). Removes the last gap blocking idiomatic Hono / koa
   middleware patterns end-to-end.
2. **lodash Tier 2 — finish the un-skip wave** — close #1302 (flow
   global index), #1303 (partial f64.trunc), #1305 (legacy var-init
   externref leak) so #1292 Tier 2b/2c/2d can drop their skip markers.
3. **#1126 IR Stage 3** — IR-claimed bitwise / shift / compare ops emit
   native `i32.*` directly instead of the JS `ToInt32` scratch dance.
   Most of the perf win lives here.
4. **Stretch — #1223 TDZ async/gen sharing** — pull only if dev-3 is
   idle after item 4 lands; otherwise demote to backlog after this
   sprint (third deferral).

## Carry-over context

Carried from S49:

- #1126 — int32/uint32 inference. **Stages 1+2 merged via PRs #205 and
  #206.** Stage 3 (~500 LoC, IR emitter integration) is the next
  landable slice. Architect spec is in the issue file.
- #1298 — function-typed field/array/Map call drops. Documented root
  cause; needs architect spec before dispatch.
- #1302 — lodash flow.js invalid global index. **Suspended-work notes
  in `worktree issue-1302-flow-global-idx`** with concrete findings
  (212 imported + 46 declared = 258 globals, but `__closure_837`
  references 258–266).
- #1303 — partial.js `mergeData` f64.trunc on externref (legacy
  codegen path). IR side already fixed in #1303 stage; legacy is the
  remaining gap.
- #1305 — module-level `var X = N` legacy global typing. Two-layer fix
  proposed; closely related to #1303.
- #1306 — `mws[idx](c, next)` on closure-typed array compiles to
  `ref.null; drop`. End-to-end gap left after #1301's validation fix.
- #1292 — lodash Tier 2 stress test. Harness landed; un-skip Tier 2b
  / 2c / 2d once their blockers land.
- #1223 — TDZ async/gen writer+reader fn-decl sharing. **Stretch /
  parking lot.** Deferred from S47, S48, S49.

Closed during this planning pass:

- #1301 — closure env field-type mismatch. Merged via PR #216 in S49;
  status corrected from `in-progress` to `done`.
- #1304 — typeof externref-wrapped function. Merged via PR #219 in S49;
  status corrected from `in-progress` to `done`.

## Sprint backlog (committed + stretch)

Order is recommended **dispatch order** (highest value first); see
`sprint-planning.md` for full rationale.

### Committed

| Order | Issue | Title | Priority | Feasibility | Notes |
|-------|-------|-------|----------|-------------|-------|
| 1 | #1298 | Function-typed field/array/Map call drops & returns null | high | hard | Architect spec required. May share fix with #1306. |
| 2 | #1306 | `mws[idx](c, next)` on closure-typed array drops to ref.null | medium | medium | Pair with #1298 spec. |
| 3 | #1126 (Stage 3) | IR emitter integration for i32/u32 lattice | high | hard | Senior-developer task. Architect spec already present (issue file lines 282-331). |
| 4 | #1302 | lodash flow.js `__closure_837` invalid global index | medium | medium | Resume in existing worktree. |
| 5 | #1303 | lodash partial.js `mergeData` f64.trunc on externref (legacy) | medium | medium | Pair with #1305. |
| 6 | #1305 | Module-level `var X = N` externref leak into bitwise legacy | medium | hard | Pair with #1303. |

### Stretch

| Order | Issue | Title | Priority | Feasibility | Notes |
|-------|-------|-------|----------|-------------|-------|
| 7 | #1292 | lodash Tier 2 — un-skip Tier 2b/2c/2d after blockers | medium | low | Tail end; assigned to whichever dev lands the last blocker. |
| 8 | #1307 | CI: serialize Test262 Sharded globally to eliminate runner-pool contention | medium | low | PR #228 open. One-line concurrency group change. |
| 9 | #1223 | TDZ async/gen writer+reader fn-decl sharing | medium | hard | Parking lot. Pull only if capacity surplus. Decide: commit or backlog after S50. |

## Architect specs needed

| Issue | Status | Required before dispatch |
|-------|--------|--------------------------|
| #1298 | **Needed** | Detection logic for `__fn_wrap_N_struct` externrefs at call sites + unbox/cast/call_ref sequence. |
| #1306 | **Bundle with #1298** | Architect should verify whether element-access call dispatch shares the same missing-unbox path. |
| #1126 Stage 3 | Present | Decomposed Stages 1-6 spec already in issue file. |
| #1305 | Present | Two-layer plan in issue file (defensive + root cause). |

## Definition of done

- #1298 + #1306 merged → Hono Tier 5c "two middlewares run in
  registration order" passes without `it.skip`; `app.get('/path', c =>
  c.text(...))` dispatches end-to-end.
- #1302 + #1303 + #1305 merged → `compileProject('lodash-es/flow.js')`
  and `'lodash-es/partial.js'` produce binaries that pass
  `new WebAssembly.Module(...)`.
- #1292 Tier 2b/2c/2d skip markers removed; all four Tier 2 cases
  green.
- #1126 Stage 3 merged → IR-claimed bitwise loops emit native
  `i32.{and,or,xor,shl,shr_s,shr_u}`. #1236 saturation canary stays
  green. test262 `Numbers/intrinsics` cluster shows no regression.
- test262 net delta ≥ 0 on each merge; no single regression
  bucket > 50.

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1298 | Calling a function-typed value stored in a field/array/Map drops the call and returns null | high | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1126 | Infer when JavaScript number flows can be safely lowered to int32 or uint32 | high | in-progress |
| #1307 | ci: serialize Test262 Sharded across PRs to eliminate runner-pool contention | medium | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1302 | Wasm validation: closure references invalid global index when compiling lodash flow.js | medium | done |
| #1303 | Wasm validation: f64.trunc emitted on externref operand when compiling lodash partial.js | medium | done |
| #1305 | Module-level var init leaks externref into bitwise op codegen (legacy path) | medium | done |
| #1306 | ElementAccessExpression call on closure-typed array drops call: mws[idx](c, next) emits ref.null | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
