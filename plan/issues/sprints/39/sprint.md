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
| 8 | **#911** | Split statements.ts into control-flow, variables, destructuring, loops, and functions modules | Completed in Sprint 39 and later merged to main. |
| 9 | **#912** | Remove circular dependencies from the core codegen backend | Completed in Sprint 39 after the file-split work landed; later merged to main. |
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

## Planning Discussion (2026-04-06)

_Integrated from `plan/log/sprints/sprint-39-planning.md`._

**PO**: Product Owner agent  
**Participants**: PO, Tech Lead

### Validation of Candidate Issues

#### Smoke Tests Performed

| Issue | Sample Test | Result | Verdict |
|-------|-----------|--------|---------|
| #848 (class computed property) | `accessor-name-inst/computed.js` | FAIL — "returned 3 — assert #2 at L40" | **Still reproduces** |
| #846 (assert.throws) | `Object/defineProperty/15.2.3.6-1-1.js` | **PASS** (now fixed) | **Stale for this sample** — needs recount |
| #847 (for-of destructuring) | `for-await-of/async-func-decl-dstr-array-elem-init-assignment.js` | FAIL — null_deref at L30 | **Still reproduces** |
| #928 (unknown failures) | `arrow-function/dstr/dflt-ary-ptrn-elision-step-err.js` | Compiles, needs runner verification | **Likely still reproduces** |

### Current Baseline Analysis

```
Total:  43,120
Pass:   18,408 (42.7%)
Fail:   21,652
Skip:    1,313
```

**Failure breakdown:**

| Category | Count | Top Pattern |
|----------|-------|-------------|
| assertion_fail | 8,662 | Wrong values in class/destructuring/built-ins |
| type_error | 6,368 | null/undefined property access |
| wasm_compile | 2,973 | "p.then is not a function" (1,442), "object is not a function" (629) |
| other | 1,377 | Misc runtime errors |
| null_deref | 604 | Null pointer in assert_throws |
| negative_test_fail | 577 | Expected SyntaxError but compiled |
| runtime_error | 560 | Misc traps |
| illegal_cast | 416 | ref.cast wrong type |

### Key Findings

1. **Promise .then() CEs dominate wasm_compile** — 1,648 of 2,973 CEs (55%) are "p.then is not a function" or "then is not a function". Sprint 38 attempted this 3 times (`#855`, `#960`, `#961`, `#964`) with partial success but regressions. High value, high risk.
2. **Array "object is not a function"** (`#827`) — 629 CEs, all in `built-ins/Array`. Straightforward: Array callback methods need proper function import registration.
3. **Class computed properties** (`#848`) — 1,015 FAIL. Computed property name evaluation does not store accessors by computed key.
4. **for-of destructuring** (`#847`) — 660 FAIL. Destructuring defaults not properly applied for holes/undefined.
5. **Several issues had stale data** — `#846` sample already passed; `#850` was `fixed-by-866`; `#857` was `fixed-by-827`.

### Feasibility Assessment

| Issue | Feasibility | Needs Architect? | Risk |
|-------|-------------|-----------------|------|
| Promise .then() CE | Hard | **YES** — 3 prior attempts failed | HIGH — regression risk |
| #848 class computed | Medium | No — clear codegen fix | LOW |
| #827 Array callbacks | Medium | No — import registration fix | LOW |
| #847 for-of destructuring | Medium | Maybe — complex destructuring paths | MEDIUM |
| #971 mixed assertions | Hard | No — analysis first | MEDIUM |
| #928 unknown failures | Medium | No — investigation | LOW |
| #864 WeakMap/WeakSet | Easy | No | LOW |
| #830 DisposableStack | Easy | No — stub extern class | LOW |
| #929 ODP on non-object | Medium | No | LOW |

### Priority Ranking

1. **#827** — 629 CE, medium effort, low risk.
2. **#848** — 1,015 FAIL, medium effort, low risk.
3. **#847** — 660 FAIL, medium effort, medium risk.
4. **Promise .then()** — 1,648 CE potential but high risk; gated behind architect spec.
5. **#971** — 180 FAIL, analysis first.
6. **#928** — 209 FAIL, investigation + fix.
7. **#864** — 45 FAIL, easy quick win.
8. **#830** — 39 CE, easy stub.
9. **#929** — 53 FAIL, medium.

### Planning Decisions

- **Promise .then() included as Phase 1 with architect gate** — do not dispatch without architect spec.
- **Max 3 devs** to keep RAM headroom for test262.
- **Phase 1 goes first**, Phase 3 only if sprint has capacity.
- **#846 needed recount** because some patterns were already fixed in Sprint 38.
- **Housekeeping**: move `#850`, `#857` to done/ because both were already fixed by other issues.

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #788 | Architecture: modularize src/ into focused subfolder structure | medium | done |
| #811 | Extract fixup passes from index.ts → fixups.ts | medium | done |
| #910 | Split expressions.ts into syntax-family modules | high | done |
| #911 | Split statements.ts into control-flow, variables, destructuring, loops, and functions modules | high | done |
| #912 | Remove circular dependencies from the core codegen backend | high | done |
| #913 | Split compiler.ts into validation, orchestration, and output modules | medium | done |
| #985 | Follow-up to #931: source-anchored locations for compiler catch paths | medium | done |
| #989 | Enrich invalid Wasm binary CEs with byte offset, WAT slice, and source-mapped location | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
