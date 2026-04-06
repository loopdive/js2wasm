# Sprint 39 — CE Reduction + Class/Destructuring Correctness

**Date**: 2026-04-06
**Goal**: Reduce wasm_compile CEs by ~700 and fix ~1,500 assertion/runtime failures, targeting 19,500+ pass (45%+)
**Baseline**: 18,408 pass / 21,652 fail / 2,973 CE / 43,120 total (42.7%)
**Planning doc**: [sprint-39-planning.md](sprint-39-planning.md)

## Context

Sprint 38 closed 28 issues but Promise work (#855/#960/#961/#964) exposed that 1,648 CEs are "p.then is not a function" — 55% of all CEs. Array callback imports (#827) account for another 629 CEs. Together, these two patterns represent 77% of wasm_compile failures.

On the runtime side, class computed properties (#848, 1,015 FAIL) and for-of destructuring (#847, 660 FAIL) are the largest fixable assertion failure clusters.

## Task Queue

### Phase 1: Highest-impact (parallel, 3 devs)

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 1 | **#827** | Array callback "object is not a function" CE | **629 CE** | Medium | sonnet | Array.every/filter/forEach/map/some/reduce — import registration fix |
| 2 | **#848** | Class computed property/accessor correctness | **1,015 FAIL** | Medium | sonnet | Computed key evaluation, accessor storage by computed value |
| 3 | **#847** | for-of/for-await-of destructuring wrong values | **660 FAIL** | Medium | sonnet | Destructuring defaults: only apply for undefined/holes, not null |

### Phase 2: High-value (after Phase 1 merges)

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 4 | **#971** | Mixed assertion failures post-sprint-38 | **~180 FAIL** | Hard | opus | Deps #967/#968/#969 done — re-analyze remaining failures |
| 5 | **#928** | Unknown failure tests (empty error message) | **209 FAIL** | Medium | sonnet | Investigate top 10, fix error capture or compiler issue |
| 6 | **NEW** | Promise .then() CE (consolidated) | **1,648 CE** | Hard | opus | **GATED: needs architect spec before dispatch** — 3 prior attempts had regressions |

### Phase 3: Quick wins (fill remaining capacity)

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 7 | **#864** | WeakMap/WeakSet invalid key errors | **45 FAIL** | Easy | sonnet | Object identity through externref |
| 8 | **#830** | DisposableStack extern class missing | **39 CE** | Easy | sonnet | Stub extern class + host import |
| 9 | **#929** | Object.defineProperty called on non-object | **53 FAIL** | Medium | sonnet | Boxing fix for ODP host import args |
| 10 | **#975** | Sprint file cleanup — remove orphan issue refs | Process | Easy | sonnet | Cleanup closed sprint files, remove -planning.md |
| 11 | **#977** | Edition chart: rename "Other" to "ES3/Core" | UI | Easy | sonnet | Update generate-editions.ts |
| 12 | **#978** | Responsive burger menu for site-nav | UI | Medium | sonnet | Mobile nav collapse, reference webassembly-org.loopdive.com |
| 13 | **#979** | Report page: add nav bar + landing page styling | UI | Medium | sonnet | Align report.html with landing page design system |

## Dev Paths (3 devs max)

**Dev-1 (sonnet)**: #827 Array callbacks → then #928 unknown failures → then #864 WeakMap
**Dev-2 (sonnet)**: #848 Class computed → then #830 DisposableStack → then #929 ODP
**Dev-3 (sonnet)**: #847 for-of destructuring → then #971 (switch to opus) → then Promise (if architect-gated)

## Model Dispatch Rules

- `feasibility: easy/medium` + `reasoning_effort: medium/high` → **sonnet**
- `feasibility: hard` or `reasoning_effort: max` → **opus**
- Promise .then() consolidation → **opus** (hard, regression-prone)
- #971 analysis → **opus** (hard, requires deep investigation)

## Acceptance Criteria (Sprint-Level)

- [ ] **CE target**: <=2,300 CE (from 2,973 — ~670 CE reduction)
- [ ] **Pass target**: >=19,500 pass (from 18,408 — ~1,100 gain)
- [ ] **No regressions**: pass count on equiv tests stays at baseline
- [ ] **Promise decision**: architect spec delivered OR explicit "defer to sprint 40" with rationale

## Risk Management

| Risk | Mitigation |
|------|-----------|
| Promise .then() causes regressions (happened 3x) | Architect gate: no dev work without spec. Equiv tests before merge. |
| #847 destructuring touches many code paths | Scoped fix: only for-of/for-await-of paths, not general destructuring |
| #971 turns out to be many unrelated issues | Time-box analysis to 2h. Fix low-hanging fruit, defer rest. |
| Array callback fix breaks existing Array tests | Equiv tests cover Array methods extensively |

## Housekeeping (pre-sprint)

- [ ] Move #850 to done/ (fixed-by-866)
- [ ] Move #857 to done/ (fixed-by-827)
- [ ] Recount #846 — some sub-patterns fixed in sprint 38; update issue with current numbers
- [ ] Update dependency-graph.md with sprint 38 completions

## Prerequisites

- #827: read existing Array method codegen in expressions.ts (compileCallExpression for Array.prototype methods)
- #848: read class codegen — computed property name evaluation vs static name storage
- #847: read destructuring codegen in compileDestructuringAssignment and for-of loop handling
- #971: review sprint 38 test262 results for remaining assertion failures after #967/#968/#969
- Promise: architect must analyze why late imports (#961) only covered ~30% of patterns

## File Contention Matrix

| Dev | Primary Files | Conflicts |
|-----|--------------|-----------|
| Dev-1 (#827) | expressions.ts (Array methods) | None with others |
| Dev-2 (#848) | class codegen, expressions.ts (class section) | None with Dev-1 (different section) |
| Dev-3 (#847) | statements.ts (for-of), expressions.ts (destructuring) | None with Dev-1/Dev-2 |

All Phase 1 items are independent — 3 devs can work in parallel.

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
