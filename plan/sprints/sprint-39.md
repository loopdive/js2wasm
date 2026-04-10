# Sprint 39 -- Diagnostics Follow-ups and Refactoring Continuation

**Date**: 2026-04-06 to 2026-04-07
**Goal**: Finish the diagnostics work that landed in early Sprint 39, then continue the contributor-readiness refactoring before resuming feature work
**Baseline**: 18,408 pass / 21,652 fail / 2,973 CE / 43,120 total (42.7%)

## Context

Sprint 39 started as a broader CE-reduction sprint, but the work that actually
landed in this cycle was diagnosis-heavy:

- eliminate remaining `0:0`/`L1:0` compiler catch-path diagnostics
- enrich `invalid Wasm binary` compile errors with source context
- narrow the remaining early-error bucket by fixing negative-test goal handling
- split persistent `compile_timeout` outliers into specific follow-up issues

Sprint 39 is now also the active continuation point for the repo-cleanup
refactoring track that was planned in Sprint 37 but never completed there:

- `#788` modularize `src/` into a more contributor-friendly folder structure
- `#811` extract fixup passes from `index.ts`
- `#742` extract and refactor `compileCallExpression`
- `#910` split `expressions.ts`
- `#911` split `statements.ts`
- `#912` remove backend circular dependencies
- `#913` split `compiler.ts`

## Completed

| Order | Issue | Title | Outcome |
|-------|-------|-------|---------|
| 1 | **#985** | Follow-up to #931: source-anchored compiler catch locations | Done — remaining compiler/object/binary catch paths now report source-anchored locations instead of `0:0` |
| 2 | **#989** | Enrich invalid Wasm binary diagnostics with source-map + WAT context | Done — full recheck `20260407-111308` now emits rich invalid-binary CEs with line/offset/WAT context |

## Implemented, Not Yet Closed

| Order | Issue | Title | Current state |
|-------|-------|-------|---------------|
| 3 | **#990** | Remaining early-error families after detectEarlyErrors() | Implemented partial fixes (negative goal handling, warning-only negatives, `using` placement, HTML-close comments, optional-chaining assignment). Full-run residual early-error FAIL bucket dropped from **610** to **327**, but some `using` grammar families still remain. |

## Continuation Scope

| Order | Issue | Title | Current state |
|-------|-------|-------|---------------|
| 4 | **#788** | Architecture: modularize `src/` into focused subfolder structure | Compatible umbrella for the contributor-facing cleanup pass. Keep scoped behind the concrete file-split tasks so path churn does not get ahead of code motion. |
| 5 | **#811** | Extract fixup passes from `index.ts` → `fixups.ts` | Low-risk refactoring slice that fits directly into the Sprint 39 cleanup work. |
| 6 | **#742** | Extract and refactor `compileCallExpression` | Refactoring fit for Sprint 39, but still blocked on the broader extraction sequence under `#688`. |
| 7 | **#910** | Split expressions.ts into syntax-family modules | Reassigned here from Sprint 37. Still open and now prioritized for repo cleanup / contributor friendliness. |
| 8 | **#911** | Split statements.ts into control-flow, variables, destructuring, loops, and functions modules | Reassigned here from Sprint 37. Still open. |
| 9 | **#912** | Remove circular dependencies from the core codegen backend | Reassigned here from Sprint 37. Still open and depends on the file-split work. |
| 10 | **#913** | Split compiler.ts into validation, orchestration, and output modules | Reassigned here from Sprint 37. Still open. |

## Carry-over

- `#990` remains a correctness carry-over in Sprint 40
- timeout follow-ups `#991` to `#996` remain queued in Sprint 40
- the refactoring track `#788`, `#811`, `#742`, and `#910` to `#913` is no longer treated as backlog carry-over; it is explicitly continued here first

## Results

- #985 completed with targeted regression coverage for compiler catch-path diagnostics
- #989 completed: in `test262-results-20260407-111308.jsonl`, **1011** `invalid Wasm binary` CEs now carry byte offset, and **1011** include WAT context; **1008** also include a source-mapped `Lx:y` prefix
- #990 materially reduced the residual early-error bucket: `expected parse/early error but compiled and instantiated successfully` fell from **610** to **327** in the full official-scope run
- #990 specific verified wins in the full run:
  - `single-line-html-close-without-lt.js` now passes
  - `optional-chaining/static-semantics-simple-assignment.js` now passes
  - `using-not-allowed-at-top-level-of-script.js` now passes
  - `using-invalid-switchstatement-caseclause.js` now passes
- #990 still has residual `using` grammar cases, e.g. `using-invalid-objectbindingpattern.js` and `block-scope-syntax-using-declarations-mixed-with-without-initializer.js`
- timeout outliers were split into dedicated follow-up issues `#991` to `#996`

## Retrospective

Sprint 39 should have been split earlier. The sprint mixed compiler correctness,
UI work, DX work, and runner-performance cleanup in one queue. Sprint 40 now
contains the remaining correctness/perf carry-over, while Sprint 39 holds the
presentation- and contributor-focused refactoring continuation.
