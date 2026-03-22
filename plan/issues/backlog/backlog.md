# ts2wasm Backlog

## 1. Compiler correctness

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [695](../done/695.md) | ✅ Done | Emit proper TypeError/ReferenceError exceptions | 4,738 FAIL |
| [696](../ready/696.md) | High | Classify "other fail" runtime errors | 4,649 FAIL |
| [698](../ready/698.md) | Medium | Call type mismatch residual | 1,044 CE |
| [697](../ready/697.md) | Medium | Struct type errors for non-class structs | 813 CE |
| [678](../ready/678.md) | High | Dynamic prototype chain (reverted — breaks struct layout) | 625 FAIL |
| [684](../ready/684.md) | High | Any-typed variable inference from usage | Many CE |
| [685](../ready/685.md) | Medium | Interprocedural return type flow | Perf + correctness |
| [686](../ready/686.md) | Medium | Closure capture type preservation | Perf |
| [683](../done/683.md) | ✅ Done | Runtime type narrowing (typeof/instanceof) | Many FAIL |
| [703](../done/703.md) | ✅ Done | Negative tests: strict-mode validation for ES-spec parse errors | 99 tests improved |

## 1b. Assertion failure sub-categories (from #727 analysis, 2026-03-22)

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [726](../ready/726.md) | Critical | TypeError regression: ref.cast guard returns ref.null | 1,948 FAIL |
| [728](../ready/728.md) | High | Null pointer dereference should throw TypeError | 1,604 FAIL |
| [729](../ready/729.md) | High | Class feature codegen gaps | 1,161 FAIL |
| [723](../ready/723.md) | High | TDZ violations: throw ReferenceError before let/const init | 230 FAIL (subset of 846) |
| [730](../ready/730.md) | High | Missing exception paths (Test262Error throws) | 708 FAIL |
| [731](../ready/731.md) | Medium | Function/class .name property | 558 FAIL |
| [732](../ready/732.md) | Medium | hasOwnProperty correctness | 520 FAIL |
| [733](../ready/733.md) | Medium | RangeError validation in built-ins | 442 FAIL |
| [734](../ready/734.md) | Medium | Array method correctness | 343 FAIL |
| [735](../ready/735.md) | Medium | Async iteration correctness | 329 FAIL |
| [736](../ready/736.md) | Medium | SyntaxError detection at compile time | 316 FAIL |
| [737](../ready/737.md) | Medium | Undefined-handling edge cases | 276 FAIL |
| [738](../ready/738.md) | Medium | instanceof correctness | 276 FAIL |
| [739](../ready/739.md) | Medium | Object.defineProperty correctness | 262 FAIL |

## 2. Runtime features & JS compatibility

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [675](../ready/675.md) | Medium | Dynamic import() | 471 tests |
| [661](../ready/661.md) | Medium | Temporal API via polyfill | 1,128 tests |
| [671](../ready/671.md) | Low | with statement support | 272 tests |
| [674](../ready/674.md) | Low | SharedArrayBuffer / Atomics | 493 tests |
| [665](../done/665.md) | ✅ Done | Native Wasm Date (i64 timestamp) | 486 tests |
| [669](../done/669.md) | ✅ Done | eval() / new Function() static compilation | 2,500 tests |
| [670](../done/670.md) | ✅ Done | Proxy get trap execution | 465 tests |
| [672](../done/672.md) | ✅ Done | WeakMap/WeakSet/WeakRef | 580 tests |
| [673](../done/673.md) | ✅ Done | Reflect API compile-time rewrites | 391 tests |
| [676](../done/676.md) | ✅ Done | RegExp exec result unpacking | 720 tests |
| [677](../done/677.md) | ✅ Done | Property descriptor writable enforcement | 1,000 tests |

## 3. Architecture — host import elimination

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [680](../ready/680.md) | High | Pure Wasm generators (state machines) | Eliminates 10 host imports |
| [681](../ready/681.md) | High | Pure Wasm iterators (struct-based) | Eliminates 5 host imports |
| [682](../ready/682.md) | Medium | RegExp Wasm engine for standalone mode | No host in WASI |
| [638](../ready/638.md) | Medium | Reverse typeIdxToStructName map | 12 O(N) → O(1) |
| [688](../ready/688.md) | Low | Refactor into smaller modules per feature | Maintainability |
| [652](../ready/652.md) | Low | Compile-time ARC / static lifetime analysis | Research |
| [679](../done/679.md) | ✅ Done | Dual string backend (js-host vs standalone) | Architecture |

## 4. Test runner optimization

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [687](../ready/687.md) | High | Live-streaming report with run selector | Developer UX |
| [694](../done/694.md) | ✅ Done | Vitest with per-test disk cache | 5x re-run speedup |
| [693](../done/693.md) | ✅ Done | skipWat + preamble cache | ~45% compile speedup |
| [689](../done/689.md) | ✅ Superseded | Memory-aware worker pool → vitest handles | — |
| [690](../done/690.md) | ✅ Superseded | Streaming results → vitest streams natively | — |
| [691](../done/691.md) | ✅ Superseded | Pipeline architecture → vitest per-test | — |
| [692](../done/692.md) | ✅ Superseded | Async pipeline → vitest parallelism | — |

## 5. Platform support

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [639](../ready/639.md) | Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon |
| [640](../ready/640.md) | High | WASI HTTP handler | Unlocks serverless edge |
| [644](../ready/644.md) | Critical | Integrate report into playground | Developer experience |
| [641](../ready/641.md) | Medium | Shopify Functions template | Best adoption opportunity |
| [642](../ready/642.md) | Low | Deno/Cloudflare loader plugins | Developer experience |

## Completed (97 issues this session, 700+ total)

See `plan/issues/done/log.md` for the full completion log.

**Session 2026-03-19/20**: 97 issues. Pass: 9,270 → 13,226 (+43%). CE: 14,950 → 6,894 (-54%). Key: WASI, native strings, WIT, tail calls, SIMD, peephole, type annotations, prototype chain, delete, TypedArray, static eval, Proxy traps, Reflect, WeakMap/Ref, RegExp, property descriptors, stack balance, native Date, type narrowing, vitest cache, skipWat.
