---
id: 46
status: closed
closed: 2026-05-02
created: 2026-04-27
groomed: 2026-04-30
started: 2026-04-30
wrap_checklist:
  status_closed: true
  retro_written: false
  diary_updated: true
  end_tag_pushed: false
  begin_tag_pushed: false
carry_overs:
  - id: 742
    status: blocked
    note: compileCallExpression refactor — blocked, moved to backlog
  - id: 1166
    status: blocked
    note: closed-world integer specialization — blocked, moved to backlog
  - id: 1169
    status: ready
    note: IR Phase 4 umbrella tracker — ongoing through S47+
---

# Sprint 46

**Date**: 2026-04-30 → TBD
**Baseline**: 25,830 / 43,168 = 59.8% (inherited from S45 close)
**Created**: 2026-04-27 — initial seed during S45 IR slice 6 work
**Groomed**: 2026-04-30 — PO + project lead planning session

> **Note (2026-04-30 PO):** the original seed narrative below was
> written before S45 actually shipped. Five of its "headline" issues
> (#1185, #1186, #1169f, #1169g, #1169h) all landed in S45. The
> sprint goal has been rewritten for the actual S46 shape decided
> with the project lead.

## Sprint goal

**Headline:** "Fix the visible gaps, then push conformance."

S46 is sequenced **C-then-A**:

  - **Phase 1 (C — benchmark & visibility cleanup):** fix the
    embarrassing gaps in the competitive benchmark table from S45
    (hosted ESM error, fib-recursive type mismatch, string-hash GC
    pressure), ship the custom domain, land the test-runtime
    native-string coercion helper. Quick wins + one hard
    performance issue (#1210).
  - **Phase 2 (A — conformance progress):** finish IR Phase 4 with
    Slice 10 steps B–E (TypedArray, ArrayBuffer/DataView,
    Date/Error/Map/Set, Promise). Ship #1205 (TDZ flag boxing for
    async/generators) so #1177 (TDZ closure captures) can be
    re-attempted after its S45 revert.

**Theme B (credibility / per-path scores / differential testing /
methodology document)** is deferred to S47. Theme A's #1126 (JS
number → int32/uint32 inference) is also deferred to S47 — it
competes with #1205 for senior-dev attention and benefits from
having the IR slice 10 work fully landed first.

## Capacity

  - **4 dev agents** for sprint dispatch
  - **1 architect agent** for spec writing on hard issues
    (spawned by tech lead 2026-04-30)
  - PO available for backlog grooming and acceptance review

## Validations completed during planning (2026-04-30)

  - **#1080** — All four umbrella children (#1076, #1077, #1078,
    #1079) landed in S45 with `status: done`. Acceptance criteria
    met. Closed and moved to `sprints/45/` to reflect actual
    completion sprint.
  - **#1126** — Deferred to S47. Frontmatter updated, file moved
    to `plan/issues/backlog/`.

## Architect spec requests (gating Phase 1 / Phase 2)

The architect is asked to add `## Implementation Plan` sections to:

  1. **#1210 — string-hash GC pressure** (gates Phase 1
     completion). Decide between Option A (pre-allocated buffer
     pattern detection), Option B (rope/StringBuilder), Option C
     (defer with explanatory note). PO recommendation: Option A —
     it's what AssemblyScript does and gets the benchmark from
     20s timeout to ~6ms. Architect to confirm detection
     feasibility and edge cases (`+=` in branches, escaping the
     loop, mixed-pattern accumulation).
  2. **#1205 — TDZ flag boxing for async/generators** (gates
     Phase 2 completion). The issue file already has a detailed
     implementation strategy (lines 91–126), but the spec was
     written before slice 7 (#1169f) shipped. Architect to
     validate that "mirror Stage 3 to async-fn / generator IR
     path" still maps cleanly to the post-slice-7 generator IR
     shape, and to identify any new capture-prepend sites in
     `src/ir/from-ast.ts:liftAsyncFunction` that need flag-ref
     boxing.

## Phase 1 — Benchmark & visibility cleanup

| Order | Issue | Owner | Effort | Notes |
|---|---|---|---|---|
| 1 | **#1188** | dev | easy / low | js2.loopdive.com custom domain. Independent. Day-1 ship. |
| 1 | **#1209** + **#1211** | dev (bundle) | easy + medium | labs hosted lane fixes — ESM resolver + fib-recursive type mismatch. Same harness, same lane, ship together. |
| 2 | **#1187** | dev | easy / medium | test-runtime JS-string ↔ native-string coercion helper. Unblocks dual-run testing for native-strings IR features. |
| 3 | **#1210** | senior dev | hard / high | string-hash GC pressure. Gated on architect spec. Senior dev only. |

## Phase 2 — Conformance progress

| Order | Issue | Owner | Effort | Notes |
|---|---|---|---|---|
| 4 | **#1169j** | dev | easy / medium | IR Slice 10 step B — TypedArray construction + index access. Pattern-copy of Step A. |
| 4 | **#1169k** | dev | easy / medium | IR Slice 10 step C — ArrayBuffer + DataView. Parallelizable with #1169j / #1169l. |
| 4 | **#1169l** | dev | easy / medium | IR Slice 10 step D — Date / Error / Map / Set. Parallelizable. |
| 5 | **#1205** | senior dev | hard / max | TDZ flag boxing for async/generators. Gated on architect spec. |
| 6 | **#1177** | dev | medium | TDZ closure captures re-attempt. Blocked on #1205 landing. Stage 1 was reverted in S45 with 14.7% regressions; #1205 fixes the underlying gap. |
| 7 (stretch) | **#1169m** | dev | medium | IR Slice 10 step E — Promise (best-effort). Stretch goal if Phase 2 finishes early. |

## Recommended dispatch ordering for 4 devs

```
Day 1:
  Dev 1 → #1188 (custom domain)
  Dev 2 → #1209 + #1211 (labs hosted bundle)
  Dev 3 → #1187 (test-runtime helper)
  Dev 4 (senior) → wait for #1210 architect spec

Day 2-N (Phase 1 merges, Phase 2 starts):
  Dev 1 → #1169j (IR Slice 10 B - TypedArray)
  Dev 2 → #1169k (IR Slice 10 C - ArrayBuffer/DataView)
  Dev 3 → #1169l (IR Slice 10 D - Date/Error/Map/Set)
  Dev 4 (senior) → #1210 string-hash → then #1205 TDZ async/gen

Day N+1 (after #1205 lands):
  Any dev → #1177 re-attempt
  Stretch → #1169m Promise
```

## Out of sprint (deferred to S47)

  - **#1126** — JS number → int32/uint32 inference. High-priority
    performance work, but hard / max reasoning effort, broad
    scope, and competes with #1205 for senior-dev attention.
    Better to land after IR Phase 4 fully closes.
  - **#1190** — research: eliminate residual CI baseline drift.
    Most concrete sub-issues already shipped in S45; remaining
    work is research questions. S47 candidate.
  - **#1201** — per-path test262 scores. Theme B; sequenced
    before #1204.
  - **#1203** — differential testing harness. Theme B.
  - **#1204** — methodology document. Theme B; depends on #1201.
  - **#1169** — IR Phase 4 umbrella tracker. Stays open through
    S46; closure waits for slice 10 fully retired and legacy
    `src/codegen/expressions.ts` / `statements.ts` removed (S47+
    work).

## Carry-overs / blocked

  - **#742** — compileCallExpression refactor (blocked).
  - **#1166** — closed-world integer specialization (blocked).
  - **#1169** — IR Phase 4 umbrella; remains open as parent of
    slice 10 sub-issues.

## Sprint planning checklist (PO)

  - [x] Validate each candidate issue against current main —
    closed #1080 (already done in S45)
  - [x] Defer #1126 to S47 — moved to backlog/
  - [x] Architect spec requests filed for #1210 + #1205
  - [x] Sprint narrative rewritten to reflect actual S46 shape
  - [ ] Build dev TaskList from Phase 1 + Phase 2 tasks
  - [ ] Push `sprint-46/begin` tag (tech lead, after dispatch
    starts)

## Notes from S45 retrospective (relevant for S46 retro)

  - **#1177 revert** cost two sprint cycles. The Stage 1
    capture-index correction was correct in isolation but
    surfaced a regression because Stage 2/3 flag boxing didn't
    reach the async-fn / generator path. **#1205 is the fix; it
    must land before #1177 is re-attempted.** This sequencing is
    locked into S46 dispatch.
  - **Sprint 45 PR-relative net deltas overcounted** vs the
    cumulative sprint delta. PRs measure against pre-merge bases
    that already include other improvements. For S46, expect the
    sprint-end test262 delta to be smaller than the sum of PR
    deltas — that's normal.
  - **Worktree cleanup** instinct improved in S45; S46 should
    keep the same discipline (remove worktrees after merge,
    write context summaries before agent termination).
  - **Three benchmark issues** (#1209, #1210, #1211) surfaced
    only during competitive benchmarking, not proactively. S46's
    Phase 1 fixes them; lesson is to integrate benchmark runs
    earlier in future sprints.

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #742 | Extract and refactor compileCallExpression (3,350 lines) | medium | blocked |
| #1166 | Closed-world integer specialization from literal call sites | high | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1169 | IR Phase 4 — migrate full compiler to IR path, retire legacy AST→Wasm codegen | high | ready |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1169j | IR Phase 4 Slice 10 step B — TypedArray construction + index access through IR | medium | done |
| #1169k | IR Phase 4 Slice 10 step C — ArrayBuffer + DataView through IR | medium | done |
| #1169l | IR Phase 4 Slice 10 step D — Date / Error / Map / Set through IR | medium | done |
| #1169m | IR Phase 4 Slice 10 step E — Promise through IR (best-effort) | low | done |
| #1184 | __str_copy_tree worklist allocates O(node.len) per flatten — bound by depth instead | high | done |
| #1187 | test-runtime: add JS-string → native-string coercion helper for dual-run testing in nativeStrings mode | medium | done |
| #1188 | Setup js2.loopdive.com custom domain for GitHub Pages | medium | done |
| #1190 | research: eliminate CI test262 baseline drift (umbrella for #1189, #1191, #1192) | high | done |
| #1201 | credibility: per-path test262 scores in test262-report.json — wire categorical data into landing page and report.html | high | done |
| #1203 | credibility: differential testing harness — compare js2wasm output vs V8/SpiderMonkey on 1000+ programs | high | done |
| #1204 | credibility: methodology document — how js2wasm is built by an AI agent team | medium | done |
| #1205 | Extend TDZ flag boxing to async functions / generators (#1177-followup) — async-fn closure capture path needs Stage 2/3 wiring | high | done |
| #1209 | labs/benchmarks: js2wasm hosted lane fails — ESM resolver error in run-node-wasm-program.mjs | medium | done |
| #1210 | labs/benchmarks: js2wasm string-hash Wasmtime lane hits 20s timeout — WasmGC i16-array GC pressure | high | done |
| #1211 | js2wasm hosted fib-recursive: Wasm validator — call param types must match | medium | done |
| #1212 | fix: Promise resolve/reject edge cases regress after #1211 any-boxing fix | medium | done |
| #1213 | ci: refresh-benchmarks workflow fails on every PR — looks for sidebar baseline at gitignored path | medium | done |
| #1214 | ci: playground benchmark baseline doesn't survive on CI runners — wasm/js timing 4x off committed numbers | medium | done |
| #1215 | fix: numeric-array .join() / .toString() must register number_toString — Wasm validation error | high | done |
| #1217 | ci(test262): smoke-canary — re-run main HEAD twice with fresh cache, fail if flip rate > 0 | medium | done |
| #1218 | ci(test262): auto-validate committed baseline on PR — spot-check 50 random pass entries | medium | done |
| #1219 | ArrayBindingPattern iter-close: destructuring hangs when iterator never sets done:true (26 compile_timeout tests) | high | done |
| #1220 | test262-worker: Promise snapshot missing + prototype poisoning leaks across fork tests (+29 conformance) | high | done |
| #1221 | test262-worker: outer catches misclassify WebAssembly.Exception as compile_error — fix harness to reclassify as fail (~256 flaky tests) | high | done |

### Won't Fix

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1189 | ci(test262): residual cross-PR regression overlap (~95%) from runner-load CT noise — not cache staleness | medium | wont-fix |

<!-- GENERATED_ISSUE_TABLES_END -->
