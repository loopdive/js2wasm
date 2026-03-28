# ts2wasm Backlog

## 1. Compiler correctness

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [789](../ready/789.md) | **CRITICAL** | TypeError null/undef guard over-triggering | **15,630 FAIL** |
| [791](../done/791.md) | Done | SyntaxError detection gaps residual | 2,167 FAIL |
| [790](../done/790.md) | Done | assert.throws(ReferenceError) not implemented | 788 FAIL |
| [695](../done/695.md) | Done | Emit proper TypeError/ReferenceError exceptions | 4,738 FAIL |
| [696](../ready/696.md) | High | Classify "other fail" runtime errors | 4,649 FAIL |
| [698](../done/698.md) | Done | Call type mismatch residual | 1,044 CE |
| [697](../done/697.md) | Done | Struct type errors for non-class structs | 813 CE |
| [678](../ready/678.md) | High | Dynamic prototype chain (reverted -- breaks struct layout) | 625 FAIL |
| [684](../ready/684.md) | High | Any-typed variable inference from usage | Many CE |
| [685](../ready/685.md) | Medium | Interprocedural return type flow | Perf + correctness |
| [686](../ready/686.md) | Medium | Closure capture type preservation | Perf |
| [683](../done/683.md) | Done | Runtime type narrowing (typeof/instanceof) | Many FAIL |
| [703](../done/703.md) | Done | Negative tests: strict-mode validation for ES-spec parse errors | 99 tests improved |

## 1b. Assertion failure sub-categories (from #727 analysis, updated 2026-03-25)

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [726](../done/726.md) | Done | TypeError regression: ref.cast guard returns ref.null | 1,948 FAIL |
| [728](../done/728.md) | Done | Null pointer dereference should throw TypeError | 1,604 FAIL |
| [729](../done/729.md) | Done | Class feature codegen gaps | 1,161 FAIL |
| [723](../done/723.md) | Done | TDZ violations: throw ReferenceError before let/const init | 230 FAIL |
| [730](../done/730.md) | Done | Missing exception paths (Test262Error throws) | 708 FAIL |
| [731](../done/731.md) | Done | Function/class .name property | 558 FAIL |
| [732](../done/732.md) | Done | hasOwnProperty correctness | 520 FAIL |
| [733](../ready/733.md) | Medium | RangeError validation in built-ins | 442 FAIL |
| [734](../done/734.md) | Done | Array method correctness | 343 FAIL |
| [735](../ready/735.md) | Medium | Async iteration correctness | 329 FAIL |
| [736](../ready/736.md) | Medium | SyntaxError detection at compile time | 316 FAIL |
| [737](../ready/737.md) | Medium | Undefined-handling edge cases | 276 FAIL |
| [738](../done/738.md) | Done | instanceof correctness | 276 FAIL |
| [739](../ready/739.md) | Medium | Object.defineProperty correctness | 262 FAIL |

## 2. Runtime features & JS compatibility

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [675](../ready/675.md) | Medium | Dynamic import() | 471 tests |
| [661](../ready/661.md) | Medium | Temporal API via polyfill | 1,128 tests |
| [671](../backlog/671.md) | Low | with statement support | 272 tests |
| [674](../ready/674.md) | Low | SharedArrayBuffer / Atomics | 493 tests |
| [665](../done/665.md) | Done | Native Wasm Date (i64 timestamp) | 486 tests |
| [669](../done/669.md) | Done | eval() / new Function() static compilation | 2,500 tests |
| [670](../done/670.md) | Done | Proxy get trap execution | 465 tests |
| [672](../done/672.md) | Done | WeakMap/WeakSet/WeakRef | 580 tests |
| [673](../done/673.md) | Done | Reflect API compile-time rewrites | 391 tests |
| [676](../done/676.md) | Done | RegExp exec result unpacking | 720 tests |
| [677](../done/677.md) | Done | Property descriptor writable enforcement | 1,000 tests |

## 3. Architecture -- host import elimination

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [680](../ready/680.md) | High | Pure Wasm generators (state machines) | Eliminates 10 host imports |
| [681](../ready/681.md) | High | Pure Wasm iterators (struct-based) | Eliminates 5 host imports |
| [682](../ready/682.md) | Medium | RegExp Wasm engine for standalone mode | No host in WASI |
| [638](../ready/638.md) | Medium | Reverse typeIdxToStructName map | 12 O(N) -> O(1) |
| [688](../ready/688.md) | Low | Refactor into smaller modules per feature | Maintainability |
| [652](../ready/652.md) | Low | Compile-time ARC / static lifetime analysis | Research |
| [679](../done/679.md) | Done | Dual string backend (js-host vs standalone) | Architecture |

## 4. Test runner optimization

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [687](../ready/687.md) | High | Live-streaming report with run selector | Developer UX |
| [694](../done/694.md) | Done | Vitest with per-test disk cache | 5x re-run speedup |
| [693](../done/693.md) | Done | skipWat + preamble cache | ~45% compile speedup |
| [689](../done/689.md) | Superseded | Memory-aware worker pool -> vitest handles | -- |
| [690](../done/690.md) | Superseded | Streaming results -> vitest streams natively | -- |
| [691](../done/691.md) | Superseded | Pipeline architecture -> vitest per-test | -- |
| [692](../done/692.md) | Superseded | Async pipeline -> vitest parallelism | -- |

## 5. Platform support

| # | Priority | Feature | Impact |
|---|----------|---------|--------|
| [639](../ready/639.md) | Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon |
| [640](../ready/640.md) | High | WASI HTTP handler | Unlocks serverless edge |
| [644](../ready/644.md) | Critical | Integrate report into playground | Developer experience |
| [641](../ready/641.md) | Medium | Shopify Functions template | Best adoption opportunity |
| [642](../ready/642.md) | Low | Deno/Cloudflare loader plugins | Developer experience |

## 6. New issues from 2026-03-26 session

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [815](../ready/815.md) | **CRITICAL** | Regression: -617 pass from patch-rescue commits | **617 PASS lost** |
| [812](../done/812.md) | Done | Test262Error extern class | 801 FAIL |
| [813](../done/813.md) | Done | gen.next is not a function | 1,164 FAIL |
| [814](../done/814.md) | Done | ArrayBuffer extern class | 413 FAIL |
| [764](../ready/764.md) | Medium | Immutable global assignment error | 240 CE |
| [766](../ready/766.md) | High | Symbol.iterator protocol for custom iterables | ~500 FAIL |
| [778](../ready/778.md) | Medium | Illegal cast errors (ref.cast wrong type) | 135 FAIL |
| [786](../ready/786.md) | Medium | Multi-assertion failures (returned N > 2) | ~1,183 FAIL |
| [793](../ready/793.md) | Medium | Infinite compilation loop on private methods | 5 hang |
| [761](../ready/761.md) | High | Rest/spread silently dropped in destructuring | ~200 FAIL |
| [763](../ready/763.md) | Medium | RegExp runtime method gaps | ~400 FAIL |
| [802](../ready/802.md) | Low | Dynamic prototype support (conditional __proto__) | property-model |
| [797](../ready/797.md) | Critical | Property descriptor subsystem (Phase 3 remaining) | ~5,000 FAIL |
| [798](../done/798.md) | Done | try/catch JS exception interop (all subtasks done) | ~3,000 FAIL |
| [799](../ready/799.md) | Critical | Prototype chain (799b done, #802 for dynamic) | ~2,500 FAIL |
| [779](../ready/779.md) | Critical | Assert failures: wrong values (analysis) | 10,099 FAIL |
| [820](../ready/820.md) | Critical | TypeError / null dereference failures | 6,077 FAIL |

## 7. Compile error issues from 2026-03-28

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [822](../ready/822.md) | **HIGH** | Wasm type mismatch compile errors (all sub-patterns) | **907 CE** |
| [824](../ready/824.md) | High | Compilation timeouts (10s limit) | **548 CE** |
| [839](../ready/839.md) | High | return_call stack args / type mismatch in constructors | **158 CE** |
| [828](../ready/828.md) | Medium | Unexpected undefined AST node in compileExpression | **149 CE** |
| [844](../ready/844.md) | Medium | Unsupported new expression for built-in classes | **85 CE** |
| [840](../ready/840.md) | Medium | Array concat/push/splice 0-arg support | **31 CE** |
| [835](../ready/835.md) | Low | Unknown extern class: Error types | **32 CE** |
| [836](../ready/836.md) | Low | Tagged templates with non-PropertyAccess tags | **20 CE** |
| [841](../ready/841.md) | Low | Unsupported Math methods (sumPrecise, cosh, sinh, tanh) | **19 CE** |
| [843](../ready/843.md) | Low | super keyword in object literals and edge cases | **20 CE** |
| [842](../ready/842.md) | Low | new Array() with non-literal/spread args: invalid vec type | **14 CE** |
| [845](../ready/845.md) | Medium | Misc CE: object literals, RegExp-on-X, for-in/of edges | **340 CE** |
| [827](../ready/827.md) | High | Array callback methods: "fn is not a function" | **243 CE** |
| [829](../ready/829.md) | Medium | Unsupported assignment target compile errors | **141 CE** |
| [830](../ready/830.md) | Low | DisposableStack extern class missing | **38 CE** |
| [831](../ready/831.md) | Medium | Negative test gaps: expected SyntaxError but compiled | **242 FAIL** |

## 8. Runtime failure issues from 2026-03-28 error analysis (NEW)

| # | Priority | Issue | Impact |
|---|----------|-------|--------|
| [852](../ready/852.md) | **CRITICAL** | Destructuring params: null_deref + illegal_cast | **1,525 FAIL** |
| [848](../ready/848.md) | **HIGH** | Class computed property / accessor correctness | **1,015 FAIL** |
| [846](../ready/846.md) | **CRITICAL** | assert.throws not thrown for invalid built-in args | **2,799 FAIL** |
| [847](../ready/847.md) | High | for-await-of / for-of destructuring wrong values | **660 FAIL** |
| [857](../ready/857.md) | High | wasm_compile: "fn is not a function" Array callbacks | **247 CE** |
| [855](../ready/855.md) | Medium | Promise resolution and async error handling | **210 FAIL** |
| [851](../ready/851.md) | High | Iterator close protocol not implemented | **147 FAIL** |
| [856](../ready/856.md) | Medium | Expected TypeError but got wrong error type | **136 FAIL** |
| [850](../ready/850.md) | High | Object-to-primitive: valueOf/toString not called | **135 FAIL** |
| [854](../ready/854.md) | High | Iterator protocol: null next/return/throw methods | **126 FAIL** |
| [858](../ready/858.md) | Medium | Worker/timeout exits and eval-code null deref | **182 FAIL** |
| [853](../ready/853.md) | Medium | WebAssembly objects are opaque (for-in/Object.create) | **58 FAIL** |
| [849](../ready/849.md) | Medium | Mapped arguments object sync with named params | **200 FAIL** |
| [825](../ready/825.md) | High | Null deref failures (updated: 1,081 total) | **1,081 FAIL** |
| [826](../ready/826.md) | High | Illegal cast failures (updated: 1,294 total) | **1,294 FAIL** |

## Completed (760+ total)

See `plan/issues/done/log.md` for the full completion log.

**Session 2026-03-19/20**: 97 issues. Pass: 9,270 -> 13,226 (+43%). CE: 14,950 -> 6,894 (-54%). Key: WASI, native strings, WIT, tail calls, SIMD, peephole, type annotations, prototype chain, delete, TypedArray, static eval, Proxy traps, Reflect, WeakMap/Ref, RegExp, property descriptors, stack balance, native Date, type narrowing, vitest cache, skipWat.

**Session 2026-03-25**: Wave of crash-free and error-model work. Pass: 14,720 -> 18,437 (+25%). CE: 4,443 -> 1,657 (-63%). Key: null guard system (#775/#780/#781/#785), exception throwing (#783), SyntaxError detection (#784), destructuring fixes (#782), sameValue fixes (#787), class features (#729), TypeError strict mode (#730), .name property (#731). New critical issue: null guard over-triggering (#789, 15,630 fail).

**Session 2026-03-26**: 15+ issues completed. Pass: 17,602 -> 20,162 (+14.5%). Key: ReferenceError/TDZ (#790), SyntaxError gaps (#791), destructuring fixes (#794/#796/#801), coercion (#795), property descriptors (#797a/b/d), try/catch interop (#798a/b/c), prototype chain (#799a/b), compile-away audit (#800), dead code elimination after terminators.

**Session 2026-03-28 (current)**: 18,041 pass, 21,181 fail, 2,284 CE, 6,580 skip. Full error analysis completed -- 13 new issues (#846-#858) covering all major runtime failure patterns.
