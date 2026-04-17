# Sprint 38 -- Correctness: Promise, Destructuring Completion & Codegen Peephole

> Historical sprint note: Sprint 38 is closed. Open issues that remained from
> this plan were returned to the backlog rather than left assigned to a closed
> sprint.

**Date**: 2026-04-04 (after sprint 37)
**Goal**: Fix remaining high-impact correctness failures + apply codegen peephole optimizations discovered via WAT analysis
**Baseline**: 18,791 pass / 43,120 (43.6%) -- sprint 37 final

## Context

Sprint 37 closed 23 issues, reaching 18,594+ pass (43.1%). The biggest remaining blockers are:
- **Promise/async** (#855) -- 210 FAIL, architect spec written, previously reverted due to regressions
- **Destructuring** (#852 partial) -- sprint 37 fixed arrow-function/dstr (+34). Most subcategories still failing.
- **Property model** (#797) -- ~5,000 FAIL remaining (WI5 not yet done)
- **Prototype chain** (#799) -- ready, architect spec in issue file

Note: #931, #946, #947, #948 are already DONE in sprint 37. Do NOT dispatch these.

## Task queue

### Phase 1: Highest-impact correctness (parallel)
| Order | Issue | Title | Impact | Effort | Model |
|-------|-------|-------|--------|--------|-------|
| 1 | #855 | Promise resolution v2 -- architect spec ready | **210 FAIL** | Hard | opus |
| 2 | #799 | Prototype chain remaining | **~2,500 FAIL** | Hard | opus |
| 3 | #858 | Worker/timeout exits and eval-code null deref | **182 FAIL** | Medium | sonnet |
| 4 | #856 | Expected TypeError but got wrong error type | **136 FAIL** | Medium | sonnet |

### Phase 2: Codegen peephole (from WAT analysis #948)
| Order | Issue | Title | Impact | Effort | Model |
|-------|-------|-------|--------|--------|-------|
| 5 | #956 | Emit i32.const directly vs f64.const+trunc (673 cases) | Size/perf | Easy | sonnet |
| 6 | #957 | Eliminate local.set+drop dead-store pattern (272 cases) | Size/perf | Easy | sonnet |
| 7 | #955 | Eliminate redundant ref.test+ref.cast pairs (8,642 cases) | Size/perf | Medium | sonnet |
| 8 | #954 | Eliminate duplicate locals (3,366 extra, 57% modules) | Size/perf | Medium | sonnet |
| 9 | #958 | Batch string concat chains into multi-arg call (531 chains) | GC allocs | Hard | opus |

### Phase 3: High-value ready items
| Order | Issue | Title | Impact | Effort | Model |
|-------|-------|-------|--------|--------|-------|
| 10 | #766 | Symbol.iterator protocol for custom iterables | ~500 FAIL | Medium | sonnet |
| 11 | #845 | Misc CE: object literals, RegExp-on-X, for-in/of edges | **340 CE** | Medium | sonnet |
| 12 | #822 | Wasm type mismatch compile errors | **907 CE** | Hard | opus |

### Phase 4: Regression fixes + infrastructure (added mid-sprint)
| Order | Issue | Title | Impact | Status | Model |
|-------|-------|-------|--------|--------|-------|
| 13 | #959 | Auto-generate test262-editions.json | DX | Done | sonnet |
| 14 | #960 | Promise type index corruption (~1,023 regression) | Critical | Done | opus |
| 15 | #961 | Promise .then() via late imports | Critical | Done | opus |
| 16 | #962 | Illegal cast regression (433 tests) | High | Done | opus |
| 17 | #963 | Runner state leak (412 false CEs) | Critical | Done | opus |
| 18 | #964 | Promise .then() 987 tests | — | Done (false passes) | — |
| 19 | #965 | Prototype null + Array methods (99 tests) | High | Done | sonnet |
| 20 | #966 | Invalid Wasm binaries (79 tests) | High | Done | sonnet |
| 21 | #967 | Array some/every/map (30 tests) | High | In progress | opus |
| 22 | #968 | Block scope dedup locals (25 tests) | High | In progress | opus |
| 23 | #969 | Misc methods bind/call/split (22 tests) | Medium | In progress | opus |
| 24 | #970 | Include sloppy tests in runner | Medium | In progress | sonnet |
| 25 | #971 | Mixed assertion failures (~180 tests) | Medium | Ready | opus |
| 26 | #972 | Landing page feature support tables | Medium | In progress | sonnet |

## Dev paths

**Dev-1 (opus)**: #855 Promise v2 -- follow architect spec (plan/issues/sprints/35/855.md) strictly, 8 work items, test262 after each WI
**Dev-2 (opus)**: #799 prototype chain -- read architect spec in issue file first
**Dev-3 (sonnet)**: #956 + #957 (easy peephole wins, independent, fast)
**Dev-4 (sonnet)**: #858 + #856 (runtime semantics, independent)

## Model dispatch rules

- `reasoning_effort: easy/medium` -> sonnet
- `reasoning_effort: max` or `feasibility: hard` -> opus

## Prerequisites

- #855 has architect spec in issue file (Implementation Plan v2) -- dev can start immediately
- #799 has architect spec in issue file -- dev can start immediately
- #956, #957 are truly easy (single-function codegen fix, clear before/after WAT)
- #958 (string concat batching) is hard -- needs architect spec before dev work

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #766 | - Symbol.iterator protocol for custom iterables | high | done |
| #799 | - Prototype chain subsystem (~2,500 tests) | critical | done |
| #845 | Miscellaneous compile errors: object literals, RegExp-on-X, for-in/of edge cases (340 CE) | medium | done |
| #954 | Eliminate duplicate local declarations (57% of modules, 3,366 extra locals) | high | done |
| #955 | Peephole: eliminate ref.test + ref.cast redundant type checks (8,642 pairs, 36% of modules) | high | done |
| #956 | Emit i32.const directly instead of f64.const + i32.trunc_sat_f64_s (673 cases, 9% of modules) | medium | done |
| #957 | Peephole: eliminate local.set N + drop dead-store pattern (272 cases, 5% of modules) | medium | done |
| #958 | String concat: batch N-operand chains into multi-arg concat (531 chains, 5% of modules) | medium | done |
| #959 | Auto-generate test262-editions.json from runner results | medium | done |
| #960 | Promise instance method imports corrupt Wasm type indices (~1,023 pass regression) | critical | done |
| #961 | Promise .then()/.catch()/.finally() regression after #960 removal (1,095 tests) | critical | done |
| #962 | illegal cast regressions after sprint 38 merges (433 tests) | high | done |
| #963 | Runner state leak: 412 false compile errors from CompilerPool fork contamination | critical | done |
| #964 | Promise .then() not resolving on all Promise types (531 tests) | critical | done |
| #965 | Prototype chain null access on static methods (71 tests) and broken Array methods (28 tests) | high | done |
| #966 | 79 genuine invalid Wasm binaries from static private fields + Promise arity | high | done |
| #967 | Array.prototype.some/every/map not resolving after #799 prototype chain (30 tests) | high | done |
| #968 | Block scope variable shadows broken by #954 dedup locals (25 tests) | high | done |
| #969 | Static method null access (bind/call) + DataView/TypedArray methods + String.split (22 tests) | medium | done |
| #970 | Include sloppy (noStrict) tests in test262 runner for report filtering | medium | done |
| #972 | Landing page: JavaScript feature support tables (implemented + not yet implemented) | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->