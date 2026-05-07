---
id: 49
status: done
created: 2026-05-03
started: 2026-05-03
closed: 2026-05-07
wrap_checklist:
  status_closed: true
  retro_written: true
  diary_updated: true
  end_tag_pushed: true
  begin_tag_pushed: true
---

# Sprint 49

**Planned**: 2026-05-03 — seeded from S48 analysis
**Started**: 2026-05-03
**Closed**: 2026-05-07

## Goals

1. **Closure/call correctness** — fix call-path bugs surfaced by Hono/lodash stress tests (#1298, #1300, #1301, #1306)
2. **lodash Tier 2** — memoize, flow, partial application (#1292, unblocked by #1300+#1302+#1303)
3. **Hono Tier 6** — next steps after Tier 5 landed in S48 (#1297)
4. **test262 runner TS7 Phase 2** — batch-parse hot path (#1290 Phase 1 done, Phase 2 pending)
5. **typeof / bitwise cleanup** — #1304 (typeof externref function), #1305 (var init externref leak)

## Issues closed (8)

- #1241 — untitled triage
- #1290 — TS7 batch-parse Phase 1 (forEachChild compat helper, 97 call sites)
- #1296 — Dogfood: compile dashboard/landing page JS to Wasm
- #1297 — Hono Tier 5 — Application class: route registration + middleware dispatch + Context
- #1299 — Virtual dispatch through abstract-base-typed dict values
- #1300 — Closure outer param in Next callback null-deref (PR #215)
- #1301 — Closure env f64/anyref field mismatch (PR #216; status corrected during S50 planning)
- #1304 — typeof externref-wrapped function returns 'object' (PR #219; status corrected during S50 planning)

## Issues carried to S50

- #1126 Stage 3 — IR emitter integration (Stages 1+2 landed in S49 via PRs #205+#206)
- #1292 — lodash Tier 2 un-skip wave
- #1298 — function-typed field/array/Map call drops (needs architect spec)
- #1302 — flow.js closure invalid global index (suspended worktree)
- #1303 — partial.js f64.trunc on externref (legacy path)
- #1305 — module-level var init externref leak into bitwise
- #1306 — mws[idx](c, next) closure-typed array call drops to ref.null

## Issues demoted to backlog

- #1223 — TDZ async/gen writer+reader fn-decl sharing (third deferral; no concrete test262 leverage)

## Retrospective

**Closed**: 2026-05-07 (4-day sprint).

### What landed

- #1290 TS7 forEachChild compat layer — unblocks Phase 2 batch-parse runner integration
- #1296 Dashboard/landing page Wasm dogfood — confirms compiler handles real project JS
- #1297 Hono Tier 5 — Application class, route registration, middleware dispatch, Context fully compiling
- #1299 Virtual dispatch fix — abstract-base dict values now dispatch to correct subclass method
- #1300 Closure outer-param fix — inline lambda Next callbacks capture outer params correctly
- #1301 Closure env field-type fix — struct.new field type alignment for f64/anyref params
- #1304 typeof fix — externref-wrapped JS functions now correctly return `'function'`

### What didn't ship

- #1126 Stage 3 — IR emitter integration deferred (Stages 1+2 landed; Stage 3 is ~500 LoC, senior scope)
- #1298/#1306 closure call dispatch wave 2 — root causes documented but architect spec not yet written
- #1292 lodash Tier 2 — harness ready but blockers (#1302/#1303/#1305) not cleared
- #1302/#1303/#1305 lodash blocker cluster — carried to S50 as the primary target

### Process notes

- PO-led S50 planning identified 2 stale `in-progress` status fields (#1301, #1304) where PRs had merged but status wasn't updated — corrected during planning
- #1223 demoted to backlog after third consecutive deferral
- Architect spec gating (#1298+#1306) formalised as pre-dispatch requirement to prevent under-specified hard issues burning dev time
- Worktree for #1302 preserved with suspended-work notes — significantly reduces ramp-up for next dev

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1241 | Untitled |  | done |
| #1290 | perf: test262 runner — TS7 batch-parse via @typescript/native-preview (132× cold speedup) | high | done |
| #1296 | Dogfood: compile dashboard/landing page JS to Wasm using js2wasm | medium | done |
| #1297 | Hono Tier 5 — Application class: route registration + middleware dispatch + Context | medium | done |
| #1299 | Virtual dispatch through abstract-base-typed dict values returns first stored subclass's method | medium | done |
| #1300 | Closure capturing outer parameter inside an inline lambda passed as a Next callback null-derefs at call time | medium | done |
| #1301 | Closure environment field-type mismatch: struct.new[0] expected f64, got anyref | medium | done |
| #1304 | typeof on externref-wrapped JS function returns 'object' instead of 'function' | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
