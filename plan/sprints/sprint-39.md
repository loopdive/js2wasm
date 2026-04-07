# Sprint 39 -- Diagnostics Follow-ups and Timeout Triage

**Date**: 2026-04-06 to 2026-04-07
**Goal**: Improve test262 diagnosis quality and turn opaque compiler/test-runner failures into actionable buckets
**Baseline**: 18,408 pass / 21,652 fail / 2,973 CE / 43,120 total (42.7%)

## Context

Sprint 39 started as a broader CE-reduction sprint, but the work that actually
landed in this cycle was diagnosis-heavy:

- eliminate remaining `0:0`/`L1:0` compiler catch-path diagnostics
- enrich `invalid Wasm binary` compile errors with source context
- narrow the remaining early-error bucket by fixing negative-test goal handling
- split persistent `compile_timeout` outliers into specific follow-up issues

## Completed

| Order | Issue | Title | Outcome |
|-------|-------|-------|---------|
| 1 | **#985** | Follow-up to #931: source-anchored compiler catch locations | Done — remaining compiler/object/binary catch paths now report source-anchored locations instead of `0:0` |
| 2 | **#989** | Enrich invalid Wasm binary diagnostics with source-map + WAT context | Done — full recheck `20260407-111308` now emits rich invalid-binary CEs with line/offset/WAT context |

## Implemented, Not Yet Closed

| Order | Issue | Title | Current state |
|-------|-------|-------|---------------|
| 3 | **#990** | Remaining early-error families after detectEarlyErrors() | Implemented partial fixes (negative goal handling, warning-only negatives, `using` placement, HTML-close comments, optional-chaining assignment). Full-run residual early-error FAIL bucket dropped from **610** to **327**, but some `using` grammar families still remain. |

## Carry-over

All non-completed Sprint 39 items except the implemented `#990` follow-up were moved into [sprint-40.md](sprint-40.md).

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
contains only the unfinished carry-over work.
