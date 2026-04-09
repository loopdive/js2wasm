# Sprint 40 -- Remaining Carry-over After Sprint 39 Refactoring Continuation

**Date**: 2026-04-07 onward
**Goal**: Resume the remaining correctness/perf carry-over after the Sprint 39 refactoring cleanup
**Baseline**: 18,899 pass / 21,164 fail / 1,734 CE / 10 CT / 43,120 total (43.8%)
**Source baseline**: `benchmarks/results/test262-report-20260407-111308.json`

## Context

Sprint 39 diagnostics landed, but Sprint 39 also now owns the active
contributor-readiness refactoring continuation (`#910`–`#913`).

The items below remain queued after that cleanup work:
- `#990` is partially implemented and reduced to a smaller residual bucket
- timeout outliers were split into dedicated issues `#991` to `#996`
- several former carry-over items were already completed and no longer appear here

Sprint 40 therefore contains the still-open compiler/runtime/timeout/perf work
that remains after the Sprint 39 cleanup pass.

## Completed So Far

| Issue | Title | Outcome |
|-------|-------|---------|
| **#882** | Test262 runner: sharded parallel execution with merged reports | Done — the repo now runs sharded test262 in CI and merges shard outputs into a stable baseline/report flow |
| **#884** | CI: GitHub Actions test262 on every PR | Done — PRs now get automated sharded test262 validation with regression diffing against the current `main` baseline |

## Task Queue

### Phase 1: Active correctness and CE-bucket reduction

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 1 | **#983** | WasmGC objects leak to JS host as opaque values | **1,087 FAIL** | Hard | opus | Cross-cutting host-boundary correctness bucket, newly isolated from April run analysis |
| 2 | **#820** | Nullish TypeError / null-pointer / illegal-cast umbrella | **6,993 FAIL** | Hard | opus | Updated umbrella over `TypeError (null/undefined access)`, null-pointer, and illegal-cast runtime families |
| 3 | **#984** | Regression: compileExpression receives undefined AST nodes in class/private generator paths | **154 CE** | Medium | sonnet | Now narrowed to real residual async-private/class paths with line-level localization |
| 4 | **#929** | Object.defineProperty called on non-object | **88 FAIL** | Medium | sonnet | Boxing/coercion fix for ODP host import args |
| 5 | **#830** | DisposableStack extern class missing | **39 FAIL** | Easy | sonnet | Stub extern class + host import |
| 6 | **#998** | Class static-private method line-terminator variants still emit argless call/return_call in constructors | **121 CE** | Hard | opus | Follow-up to #839, split by enriched WAT and `C_$` / `C_x` helpers |
| 7 | **#999** | for-of / for-await-of destructuring still emits f64↔externref and struct field mismatches | **75 CE** | Hard | opus | Compile-time follow-up to destructuring work; WAT now points at loop lowering |
| 8 | **#997** | BigInt ToPrimitive/wrapped-value helper emits i64 into externref `__call_fn_0` wrapper | **55 CE** | Medium | sonnet | BigInt helper/wrapper path isolated by #989 enrichment |
| 9 | **#986** | BigInt serialization crash in statement/object emit paths | **37 CE** | Medium | sonnet | Newly localized by #985 and enriched in `111308` |
| 10 | **#987** | Residual object-literal spread/shape mapping gaps | **40 CE** | Medium | sonnet | Narrow follow-up to old object-literal umbrella fixes |
| 11 | **#988** | FinalizationRegistry constructor unsupported | **23 CE** | Low | sonnet | Residual built-in constructor gap after #844 cleanup |
| 12 | **#990** | Residual early-error families after Sprint 39 partial fixes | **327 FAIL** | Hard | opus | Remaining `using`, module grammar, reserved-word, class/static semantics |
| 13 | **#1002** | RegExp js-host mode completion | Built-ins correctness | Medium | sonnet | Finish Symbol protocol and remaining host-wrapper semantics independently of standalone-engine work |
| 14 | **#1006** | Support `eval` via JS host import | JS-host semantics / eval correctness | Medium | sonnet | Route non-compiled-away `eval` through explicit host imports instead of failing as unsupported |

### Phase 2: Timeout elimination

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 15 | **#824** | Timeout umbrella / timeout reporting cleanup | Historical `548 CE` stale bucket, current runner timeout-model cleanup | Medium | sonnet | Umbrella that now explains the move from old `10s` compile-error counting to targeted `#991`–`#996` worker-timeout fixes |
| 16 | **#991** | Iterator helper generator-reentrancy timeout cluster | **3 CT** | Medium | sonnet | `filter` / `flatMap` / `map` generator-is-running tests burn ~90s worker time/run |
| 17 | **#993** | Legacy try-statement timeout cluster | **3 CT** | Medium | sonnet | `S12.14_A9/A11/A12_T3` burn ~90s worker time/run |
| 18 | **#992** | Iterator.prototype.take timeout | **1 CT** | Medium | sonnet | `limit-less-than-total.js` singleton timeout |
| 19 | **#994** | Class static-private-getter timeout | **1 CT** | Medium | sonnet | singleton class/private lowering timeout |
| 20 | **#995** | localeCompare singleton timeout | **1 CT** | Low | sonnet | string built-in compile-path outlier |
| 21 | **#996** | toSorted comparefn singleton timeout | **1 CT** | Low | sonnet | array sorting/helper compile-path outlier |

### Phase 3: Benchmark and planning follow-ups

| Order | Issue | Title | Impact | Effort | Model | Notes |
|-------|-------|-------|--------|--------|-------|-------|
| 22 | **#832** | Upgrade to TypeScript 6.x for Unicode 16.0.0 support | 82 skips / parser currency | Medium | sonnet | Brings current Unicode identifier support into scope |
| 23 | **#1001** | Preallocate counted `number[]` push loops into dense WasmGC arrays | Landing-page perf / array benchmark regression | Medium | sonnet | Specialize counted append loops instead of generic growable vec-wrapper lowering |
| 24 | **#1004** | Optimize repeated string concatenation via compile-time folding and counted-loop aggregation | Landing-page perf / string benchmark regression | Medium | sonnet | Reduce repeated concat work on the default optimized path, not only via `fast: true` |
| 25 | **#1005** | Benchmark cold-start startup across Wasmtime, Wasm in Node.js, and native JS in Node.js | Server/runtime startup benchmarking | Medium | sonnet | Add a reproducible fresh-process cold-start benchmark distinct from browser incremental loading |
| 26 | **#1000** | Normalize issue frontmatter and repopulate historical sprint issue assignments | Process / dashboard correctness | Medium | sonnet | Planning-data cleanup for issue frontmatter, done log, and historical sprint Kanban reconstruction |
| 27 | **#1003** | Normalize issue metadata: add ES edition, language feature, and task type to all issue frontmatter | Planning / dashboard correctness | Medium | sonnet | Extends #1000 with richer machine-readable issue metadata |

## Acceptance Criteria

- [ ] Reduce at least one of the large newly isolated carry-over buckets `#983` or `#984`
- [ ] Close or substantially reduce the residual `#990` early-error families left after Sprint 39
- [ ] Land or clearly scope JS-host `eval` support for `#1006`
- [ ] Remove the 10 known `compile_timeout` cases from the full official-scope run
- [ ] Land at least one of the enriched invalid-Wasm follow-ups `#997`, `#998`, or `#999`
- [ ] Upgrade or validate the parser/toolchain path needed for `#832` so Unicode 16 identifier tests can run
- [ ] Land a counted-array fast path for `#1001` or otherwise recover the lost `array.ts` benchmark advantage
- [ ] Land compile-time / counted-loop concat optimization for `#1004` or substantially reduce the `string.ts` benchmark slowdown
- [ ] Add a reproducible cold-start benchmark for `#1005` comparing Wasmtime, Wasm-in-Node, and JS-in-Node
- [ ] Finish the planning-data normalization tracked in `#1000` and `#1003`
- [ ] Keep Sprint 40 scoped to genuine carry-over only; newly discovered work starts in Sprint 41

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
