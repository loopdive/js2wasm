# Sprint 40 -- Remaining Carry-over from Sprint 39

**Date**: 2026-04-07
**Goal**: Convert Sprint 39 diagnostics into concrete compiler/runtime fixes
**Baseline**: 18,899 pass / 21,164 fail / 1,734 CE / 10 CT / 43,120 total (43.8%)
**Source baseline**: `benchmarks/results/test262-report-20260407-111308.json`

## Context

Sprint 39 is now effectively closed:

- `#985` is done
- `#989` is done
- `#990` is partially implemented and now reduced to a smaller residual bucket
- timeout outliers were split into dedicated issues `#991` to `#996`

Several former carry-over items were also verified or completed separately and
should no longer appear in the active Sprint 40 queue:

- done: `#827`, `#847`, `#848`, `#864`, `#971`, `#975`, `#977`, `#978`, `#979`, `#980`, `#981`, `#982`

Sprint 40 therefore contains only the still-open compiler/runtime/timeout work.

## Task Queue

### Phase 1: Active correctness and CE-bucket reduction

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 1 | **#983** | WasmGC objects leak to JS host as opaque values | **1,087 FAIL** | Hard | opus | Cross-cutting host-boundary correctness bucket, newly isolated from April run analysis |
| 2 | **#984** | Regression: compileExpression receives undefined AST nodes in class/private generator paths | **154 CE** | Medium | sonnet | Now narrowed to real residual async-private/class paths with line-level localization |
| 3 | **#929** | Object.defineProperty called on non-object | **88 FAIL** | Medium | sonnet | Boxing/coercion fix for ODP host import args |
| 4 | **#830** | DisposableStack extern class missing | **39 FAIL** | Easy | sonnet | Stub extern class + host import |
| 5 | **#998** | Class static-private method line-terminator variants still emit argless call/return_call in constructors | **121 CE** | Hard | opus | Follow-up to #839, split by enriched WAT and `C_$` / `C_x` helpers |
| 6 | **#999** | for-of / for-await-of destructuring still emits f64↔externref and struct field mismatches | **75 CE** | Hard | opus | Compile-time follow-up to destructuring work; WAT now points at loop lowering |
| 7 | **#997** | BigInt ToPrimitive/wrapped-value helper emits i64 into externref `__call_fn_0` wrapper | **55 CE** | Medium | sonnet | BigInt helper/wrapper path isolated by #989 enrichment |
| 8 | **#986** | BigInt serialization crash in statement/object emit paths | **37 CE** | Medium | sonnet | Newly localized by #985 and enriched in `111308` |
| 9 | **#987** | Residual object-literal spread/shape mapping gaps | **40 CE** | Medium | sonnet | Narrow follow-up to old object-literal umbrella fixes |
| 10 | **#988** | FinalizationRegistry constructor unsupported | **23 CE** | Low | sonnet | Residual built-in constructor gap after #844 cleanup |
| 11 | **#990** | Residual early-error families after Sprint 39 partial fixes | **327 FAIL** | Hard | opus | Remaining `using`, module grammar, reserved-word, class/static semantics |

### Phase 2: Timeout elimination

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 12 | **#991** | Iterator helper generator-reentrancy timeout cluster | **3 CT** | Medium | sonnet | `filter` / `flatMap` / `map` generator-is-running tests burn ~90s worker time/run |
| 13 | **#993** | Legacy try-statement timeout cluster | **3 CT** | Medium | sonnet | `S12.14_A9/A11/A12_T3` burn ~90s worker time/run |
| 14 | **#992** | Iterator.prototype.take timeout | **1 CT** | Medium | sonnet | `limit-less-than-total.js` singleton timeout |
| 15 | **#994** | Class static-private-getter timeout | **1 CT** | Medium | sonnet | singleton class/private lowering timeout |
| 16 | **#995** | localeCompare singleton timeout | **1 CT** | Low | sonnet | string built-in compile-path outlier |
| 17 | **#996** | toSorted comparefn singleton timeout | **1 CT** | Low | sonnet | array sorting/helper compile-path outlier |

### Phase 3: Planning-data cleanup

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 18 | **#1000** | Normalize issue frontmatter and repopulate historical sprint issue assignments | Process / dashboard correctness | Medium | sonnet | Planning-data cleanup for issue frontmatter, done log, and historical sprint Kanban reconstruction |

## Acceptance Criteria

- [ ] Reduce at least one of the large newly isolated carry-over buckets `#983` or `#984`
- [ ] Close or substantially reduce the residual `#990` early-error families left after Sprint 39
- [ ] Remove the 10 known `compile_timeout` cases from the full official-scope run
- [ ] Land at least one of the enriched invalid-Wasm follow-ups `#997`, `#998`, or `#999`
- [ ] Finish the planning-data normalization tracked in `#1000`
- [ ] Keep Sprint 40 scoped to genuine carry-over only; newly discovered work starts in Sprint 41

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
