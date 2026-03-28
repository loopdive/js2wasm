# ts2wasm Backlog

**Current state** (2026-03-28): 18,041 pass | 21,181 fail | 2,284 CE | 6,580 skip

---

## 1. Compiler Correctness -- Type Mismatches, AST Nodes, return_call

Issues where the compiler emits invalid Wasm (type errors, missing args, bad casts) or fails to handle AST nodes.

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [822](../ready/822.md) | **HIGH** | Wasm type mismatch compile errors (all sub-patterns) | **907 CE** | Ready |
| [839](../ready/839.md) | High | return_call stack args / type mismatch in constructors | **158 CE** | Ready |
| [828](../ready/828.md) | Medium | Unexpected undefined AST node in compileExpression | **149 CE** | Ready |
| [829](../ready/829.md) | Medium | Unsupported assignment target compile errors | **141 CE** | Ready |
| [844](../ready/844.md) | Medium | Unsupported new expression for built-in classes | **85 CE** | Ready |
| [845](../ready/845.md) | Medium | Misc CE: object literals, RegExp-on-X, for-in/of edges | **340 CE** | Ready |
| [831](../ready/831.md) | Medium | Negative test gaps: expected SyntaxError but compiled | **242 FAIL** | Ready |
| [840](../ready/840.md) | Medium | Array concat/push/splice 0-arg support | **31 CE** | Ready |
| [836](../ready/836.md) | Low | Tagged templates with non-PropertyAccess tags | **20 CE** | Ready |
| [843](../ready/843.md) | Low | super keyword in object literals and edge cases | **20 CE** | Ready |
| [842](../ready/842.md) | Low | new Array() with non-literal/spread args | **14 CE** | Ready |
| [835](../ready/835.md) | Low | Unknown extern class: Error types | **32 CE** | Ready |
| [684](../ready/684.md) | High | Any-typed variable inference from usage | Many CE | Ready |
| [685](../ready/685.md) | Medium | Interprocedural return type flow | Perf + correctness | Ready |
| [686](../ready/686.md) | Medium | Closure capture type preservation | Perf | Ready |
| [736](../ready/736.md) | Medium | SyntaxError detection at compile time | 316 FAIL | Ready |

## 2. Runtime Semantics -- Assertions, Type Errors, Destructuring, Iterators

Issues where compiled Wasm runs but produces wrong values or wrong error types.

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [846](../ready/846.md) | **CRITICAL** | assert.throws not thrown for invalid built-in args | **2,799 FAIL** | Ready |
| [852](../ready/852.md) | **CRITICAL** | Destructuring params: null_deref + illegal_cast | **1,525 FAIL** | Ready |
| [820](../ready/820.md) | **CRITICAL** | TypeError / null dereference failures (umbrella) | **6,077 FAIL** | Ready |
| [779](../ready/779.md) | **CRITICAL** | Assert failures: wrong values (umbrella/analysis) | **10,099 FAIL** | Ready |
| [825](../ready/825.md) | High | Null dereference failures (sub-issue of #820) | **1,081 FAIL** | Ready |
| [826](../ready/826.md) | High | Illegal cast failures (sub-issue of #820) | **1,294 FAIL** | Ready |
| [848](../ready/848.md) | High | Class computed property / accessor correctness | **1,015 FAIL** | Ready |
| [847](../ready/847.md) | High | for-await-of / for-of destructuring wrong values | **660 FAIL** | Ready |
| [786](../ready/786.md) | Medium | Multi-assertion failures (returned N > 2) | **2,142 FAIL** | In-progress |
| [766](../ready/766.md) | High | Symbol.iterator protocol for custom iterables | ~500 FAIL | Ready |
| [761](../ready/761.md) | High | Rest/spread silently dropped in destructuring | ~200 FAIL | Ready |
| [856](../ready/856.md) | Medium | Expected TypeError but got wrong error type | **136 FAIL** | Ready |
| [850](../ready/850.md) | High | Object-to-primitive: valueOf/toString not called | **135 FAIL** | Ready |
| [849](../ready/849.md) | Medium | Mapped arguments object sync with named params | **200 FAIL** | Ready |
| [855](../ready/855.md) | Medium | Promise resolution and async error handling | **210 FAIL** | Ready |
| [858](../ready/858.md) | Medium | Worker/timeout exits and eval-code null deref | **182 FAIL** | Ready |
| [853](../ready/853.md) | Medium | WebAssembly objects are opaque (for-in/Object.create) | **58 FAIL** | Ready |
| [778](../ready/778.md) | Medium | Illegal cast errors (ref.cast wrong type) | 135 FAIL | Ready |
| [737](../ready/737.md) | Medium | Undefined-handling edge cases | 276 FAIL | Ready |
| [821](../ready/821.md) | High | BindingElement null guard over-triggering | 537 FAIL | Review |
| [764](../ready/764.md) | Medium | Immutable global assignment error | 240 CE | Ready |

## 3. Built-in Methods -- Array, Set, Map, Math, Error, RegExp

Issues where built-in method implementations are missing, incomplete, or incorrect.

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [827](../ready/827.md) | High | Array callback methods: "fn is not a function" | **243 CE** | Ready |
| [857](../ready/857.md) | High | wasm_compile: "fn is not a function" Array callbacks | **247 CE** | Ready |
| [733](../ready/733.md) | Medium | RangeError validation in built-ins | 442 FAIL | Ready |
| [763](../ready/763.md) | Medium | RegExp runtime method gaps | ~400 FAIL | Ready |
| [841](../ready/841.md) | Low | Unsupported Math methods (sumPrecise, cosh, sinh, tanh) | **19 CE** | Ready |
| [739](../ready/739.md) | Medium | Object.defineProperty correctness | 262 FAIL | Ready |

## 4. Class Features -- Computed Props, Super, Private Fields, Accessors

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [848](../ready/848.md) | High | Class computed property / accessor correctness | **1,015 FAIL** | Ready (also in Runtime) |
| [793](../ready/793.md) | Medium | Infinite compilation loop on private methods | 5 hang | Ready |
| [843](../ready/843.md) | Low | super keyword in object literals and edge cases | **20 CE** | Ready (also in Compiler) |

## 5. Iterator / Generator / Async Model

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [851](../ready/851.md) | High | Iterator close protocol not implemented | **147 FAIL** | Ready |
| [854](../ready/854.md) | High | Iterator protocol: null next/return/throw methods | **126 FAIL** | Ready |
| [735](../blocked/735.md) | Medium | Async iteration correctness | 329 FAIL | Blocked |
| [680](../ready/680.md) | High | Pure Wasm generators (state machines) | Eliminates 10 host imports | Ready |
| [681](../ready/681.md) | High | Pure Wasm iterators (struct-based) | Eliminates 5 host imports | Ready |

## 6. Property Model / Prototype Chain

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [797](../ready/797.md) | Critical | Property descriptor subsystem (Phase 3 remaining) | ~5,000 FAIL | Ready |
| [799](../ready/799.md) | Critical | Prototype chain (remaining: #802 for dynamic) | ~2,500 FAIL | Ready |
| [802](../ready/802.md) | Low | Dynamic prototype support (conditional __proto__) | property-model | Ready |
| [678](../ready/678.md) | High | Dynamic prototype chain (reverted -- breaks struct layout) | 625 FAIL | Ready |

## 7. Test Infrastructure

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [824](../ready/824.md) | High | Compilation timeouts (10s limit) | **548 CE** | Ready |
| [858](../ready/858.md) | Medium | Worker/timeout exits and eval-code null deref | **182 FAIL** | Ready (also in Runtime) |
| [687](../ready/687.md) | High | Live-streaming report with run selector | Developer UX | Ready |
| [696](../ready/696.md) | High | Classify "other fail" runtime errors | 4,649 FAIL | Ready |
| [699](../ready/699.md) | High | Shared compiler pool for test262 | Perf | Ready |
| [832](../ready/832.md) | Medium | Upgrade to TypeScript 6.x for Unicode 16.0 identifiers | 82 skip | Ready |
| [833](../ready/833.md) | Low | Consider sloppy mode support for legacy octal escapes | 16 skip | Ready |

## 8. Proposals and Standards -- Temporal, SharedArrayBuffer, BigInt Arrays, Set Methods, Disposable

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [661](../ready/661.md) | Medium | Temporal API via polyfill | 1,128 tests | Ready |
| [674](../ready/674.md) | Low | SharedArrayBuffer / Atomics | 493 tests | Ready |
| [834](../ready/834.md) | Low | ES2025 Set methods (union, intersection, etc.) | 216 skip | Ready |
| [837](../ready/837.md) | Low | Map/WeakMap upsert (getOrInsert/getOrInsertComputed) | ~110 skip | Ready |
| [838](../ready/838.md) | Low | BigInt64Array / BigUint64Array typed arrays | 19 skip | Ready |
| [830](../ready/830.md) | Low | DisposableStack extern class missing | **38 CE** | Ready |
| [844](../ready/844.md) | Medium | Unsupported new for built-in classes (SAB, AggregateError, etc.) | **85 CE** | Ready (also in Compiler) |
| [675](../ready/675.md) | Medium | Dynamic import() | 471 tests | Ready |
| [671](../backlog/671.md) | Low | with statement support | 272 tests | Backlog |

## 9. Architecture / Refactoring

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [688](../ready/688.md) | Low | Refactor into smaller modules per feature | Maintainability | Ready |
| [741](../ready/741.md) | Medium | Extract string/any helpers from index.ts | Maintainability | Ready |
| [788](../ready/788.md) | Medium | Modularize src/ into focused subfolder structure | Maintainability | Ready |
| [803](../ready/803.md) | Medium | Extract call dispatch -> calls.ts | Maintainability | Ready (sub of #688) |
| [804](../ready/804.md) | Medium | Extract new expressions -> new-expression.ts | Maintainability | Ready (sub of #688) |
| [805](../ready/805.md) | Medium | Extract assignment/destructuring -> assignments.ts | Maintainability | Ready (sub of #688) |
| [806](../ready/806.md) | Medium | Extract increment/decrement -> unary-update.ts | Maintainability | Ready (sub of #688) |
| [807](../ready/807.md) | Medium | Extract Date/Math/console -> builtins.ts | Maintainability | Ready (sub of #688) |
| [808](../ready/808.md) | Medium | Extract string/import infra -> imports.ts | Maintainability | Ready (sub of #688) |
| [809](../ready/809.md) | Medium | Extract native string helpers -> native-strings.ts | Maintainability | Ready (sub of #688) |
| [810](../ready/810.md) | Medium | Extract class compilation -> class-codegen.ts | Maintainability | Ready (sub of #688) |
| [811](../ready/811.md) | Medium | Extract fixup passes -> fixups.ts | Maintainability | Ready (sub of #688) |
| [638](../ready/638.md) | Medium | Reverse typeIdxToStructName map | 12 O(N)->O(1) | Ready |
| [652](../ready/652.md) | Low | Compile-time ARC / static lifetime analysis | Research | Ready |
| [682](../ready/682.md) | Medium | RegExp Wasm engine for standalone mode | No host in WASI | Ready |

## 10. Performance Optimization

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [743](../ready/743.md) | Critical | Whole-program type mapper | High pass impact | Ready |
| [773](../ready/773.md) | Critical | Monomorphize functions with call-site types | High pass impact | Ready |
| [745](../ready/745.md) | High | Tagged union types for WasmGC | Type precision | Ready |
| [744](../blocked/744.md) | High | Monomorphize: specialized function copies | Perf | Blocked by #743 |
| [746](../blocked/746.md) | Medium | Hidden class optimization | Perf | Blocked |
| [747](../blocked/747.md) | Medium | Escape analysis / stack allocation | Perf | Blocked |
| [699](../ready/699.md) | High | Shared compiler pool for test262 | Test perf | Ready |
| [700](../blocked/700.md) | High | Reuse ts.CompilerHost across compilations | 25% speedup | Blocked by #699 |

## 11. Platform Support

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [639](../ready/639.md) | Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon | Ready |
| [640](../ready/640.md) | High | WASI HTTP handler | Unlocks serverless edge | Ready |
| [644](../ready/644.md) | Critical | Integrate report into playground | Developer experience | Ready |
| [641](../ready/641.md) | Medium | Shopify Functions template | Best adoption opportunity | Ready |
| [642](../ready/642.md) | Low | Deno/Cloudflare loader plugins | Developer experience | Ready |

---

## Completed (760+ total)

See `plan/issues/done/log.md` for the full completion log.

**Session 2026-03-19/20**: 97 issues. Pass: 9,270 -> 13,226 (+43%). CE: 14,950 -> 6,894 (-54%).
**Session 2026-03-25**: Pass: 14,720 -> 18,437 (+25%). CE: 4,443 -> 1,657 (-63%).
**Session 2026-03-26**: Pass: 17,602 -> 20,162 (+14.5%).
**Session 2026-03-28 (current)**: 18,041 pass, 21,181 fail, 2,284 CE, 6,580 skip. Full error analysis: 13 new runtime issues (#846-#858), 7 new CE issues (#839-#845).
