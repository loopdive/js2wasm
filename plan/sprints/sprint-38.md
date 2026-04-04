# Sprint 38 — Error Quality, Regressions & Promise Redo

**Date**: TBD (after sprint 37)
**Goal**: Fix rejected issues, improve error reporting, redo Promise support safely
**Baseline**: TBD (sprint 37 result)

## Context

Sprint 36 rejected #931 (error line migration crashed the compiler) and reverted #855 (Promise support caused 1,451 regressions). Both need careful redo with max reasoning effort and full test262 validation.

Sprint 37's refactoring (#910-#913) may make these changes cleaner if it lands first.

## Task queue

### Phase 1: Fix rejected sprint 36 work
| Order | Issue | Title | Impact | Effort | Model |
|-------|-------|-------|--------|--------|-------|
| 1 | #931 | Error line numbers — debug and fix the crash from 132-call migration | **High** — DX | Hard | opus |
| 2 | #855 | Promise resolution v2 — redo with architect spec, receiver type guards | **210 FAIL** | Hard | opus |

### Phase 2: Additional error quality
| Order | Issue | Title | Impact | Effort | Model |
|-------|-------|-------|--------|--------|-------|
| 3 | #946 | Show strict mode compatibility by default on all pages | Medium | Easy | sonnet |
| 4 | #932 follow-up | Update feature coverage % with post-sprint-37 data | Low | Easy | sonnet |

### Phase 3: Regression recovery
| Order | Issue | Title | Impact | Effort | Model |
|-------|-------|-------|--------|--------|-------|
| 5 | #919 follow-up | Verify async closure wrapping doesn't break with #855 v2 | Medium | Medium | sonnet |
| 6 | #920 follow-up | Verify RegExp fallthrough interacts correctly with #797 property model | Medium | Medium | sonnet |

## Dev paths

**Dev-1 (opus/senior-developer)**: #931 — must bisect the crash first (which of 132 migrations caused it), fix incrementally, test262 after each batch
**Dev-2 (opus/senior-developer)**: #855 v2 — architect spec already written (plan/issues/ready/855.md Implementation Plan v2). Follow the 8 work items strictly.
**Dev-3 (sonnet)**: #946 strict mode + follow-ups

## Prerequisites

- #931 must be debugged before retry — find which of 132 error-push migrations caused the crash
- #855 v2 depends on architect spec (already written) and #944 revert (already merged)
- Sprint 37's #797 (property descriptors) may interact with #855 — coordinate

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
