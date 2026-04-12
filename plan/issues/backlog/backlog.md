---
title: "js2wasm Backlog"
status: backlog
sprint: Backlog
---
# js2wasm Backlog

**Current state** (2026-04-07, official scope): 18,899 pass | 21,164 fail | 1,734 CE | 10 CT | 1,313 skip

**Assignment note** (2026-04-09): this backlog is a global open-issue index.
Some entries are actively assigned to Sprint 39 or Sprint 40; closed-sprint
carry-over was normalized so open issues no longer point at stale completed
sprints.

---

## 1. Compiler Correctness -- Type Mismatches, AST Nodes, return_call

Issues where the compiler emits invalid Wasm (type errors, missing args, bad casts) or fails to handle AST nodes.

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [984](../ready/984.md) | Medium | Regression: compileExpression receives undefined AST nodes in class/private generator paths | **154 CE** | Ready |
| [997](../ready/997.md) | High | BigInt ToPrimitive/wrapped-value helper emits i64 into externref __call_fn_0 wrapper | **55 CE** | Ready |
| [998](../ready/998.md) | High | Class static-private method line-terminator variants still emit argless call/return_call in constructors | **121 CE** | Ready |
| [999](../ready/999.md) | High | for-of / for-await-of destructuring still emits f64↔externref and struct field mismatches | **75 CE** | Ready |
| [986](../ready/986.md) | Medium | Internal compiler crash: BigInt serialization in statement/object emit paths | **37 CE** | Ready |
| [987](../ready/987.md) | Medium | Object-literal spread/object-shape fallbacks still fail in generator and spread call sites | **40 CE** | Ready |
| [991](../ready/991.md) | High | Iterator helper generator-reentrancy tests hit 30s compiler timeout | **3 CT** | Ready |
| [992](../ready/992.md) | Medium | Iterator.prototype.take limit-less-than-total hits 30s compiler timeout | **1 CT** | Ready |
| [993](../ready/993.md) | High | Legacy try-statement tests S12.14_A9/A11/A12_T3 hit 30s compiler timeout | **3 CT** | Ready |
| [994](../ready/994.md) | Medium | Class static-private-getter test hits 30s compiler timeout | **1 CT** | Ready |
| [995](../ready/995.md) | Low | String.prototype.localeCompare 15.5.4.9_CE hits 30s compiler timeout | **1 CT** | Ready |
| [996](../ready/996.md) | Low | Array.prototype.toSorted comparefn-not-a-function hits 30s compiler timeout | **1 CT** | Ready |
| [990](../ready/990.md) | **HIGH** | Remaining early-error gaps after detectEarlyErrors(): reserved words, module grammar, using, ASI | **327 FAIL** | Ready |
| [926](../ready/926.md) | Low | Fixture tests not supported in unified mode | **172 CE** | Ready |
| [684](../ready/684.md) | High | Any-typed variable inference from usage | Many CE | Ready |
| [685](../ready/685.md) | Medium | Interprocedural return type flow | Perf + correctness | Ready |

## 2. Runtime Semantics -- Assertions, Type Errors, Destructuring, Iterators

Issues where compiled Wasm runs but produces wrong values or wrong error types.

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [846](../ready/846.md) | **CRITICAL** | assert.throws not thrown for invalid built-in args | **2,799 FAIL** | Ready |
| [820](../ready/820.md) | **CRITICAL** | Nullish TypeError / null-pointer / illegal-cast umbrella | **6,993 FAIL** | Ready |
| [779](../ready/779.md) | **CRITICAL** | Assert failures: wrong values (umbrella/analysis) | **8,674 FAIL** | Ready |
| [825](../ready/825.md) | High | Null dereference failures (sub-issue of #820) | **2,295 FAIL** | Ready |
| [826](../ready/826.md) | High | Illegal cast failures (sub-issue of #820) | **1,276 FAIL** | Ready |
| [786](../ready/786.md) | Medium | Multi-assertion failures (returned N > 2) | **2,142 FAIL** | In-progress |
| [859](../ready/859.md) | High | Map.forEach callback captures are immutable snapshots (runtime hang) | **1 hang** | Ready |
| [860](../ready/860.md) | Medium | Promise executor and property-assigned fns not compiled as host callbacks | **1 hang** | Ready |
| [983](../ready/983.md) | High | WasmGC objects leak to JS host as opaque values | **1,087 FAIL** | Ready |
| [821](../ready/821.md) | High | BindingElement null guard over-triggering | 537 FAIL | Review |
| [929](../ready/929.md) | Medium | Object.defineProperty called on non-object | **88 FAIL** | Ready |

## 3. Built-in Methods -- Array, Set, Map, Math, Error, RegExp

Issues where built-in method implementations are missing, incomplete, or incorrect.

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [739](../ready/739.md) | Medium | Object.defineProperty correctness | 262 FAIL | Ready |

## 4. Class Features -- Computed Props, Super, Private Fields, Accessors

No standalone open issues remain in this category right now. Active class-related
work is tracked under compiler/runtime buckets such as [#984](../ready/984.md)
and [#998](../ready/998.md); [#848](../done/848.md) is already complete.

## 5. Iterator / Generator / Async Model

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [854](../ready/854.md) | High | Iterator protocol: null next/return/throw methods | **126 FAIL** | Ready |
| [735](../blocked/735.md) | Medium | Async iteration correctness | 329 FAIL | Blocked |
| [680](../ready/680.md) | High | Pure Wasm generators (state machines) | Eliminates 10 host imports | Ready |
| [681](../ready/681.md) | High | Pure Wasm iterators (struct-based) | Eliminates 5 host imports | Ready |

## 6. Property Model / Prototype Chain

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [802](../ready/802.md) | Low | Dynamic prototype support (conditional __proto__) | property-model | Ready |

## 7. Test Infrastructure

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [824](../ready/824.md) | High | Timeout umbrella / timeout reporting cleanup | Historical `548 CE` stale bucket | Ready |
| [1000](../ready/1000.md) | High | Normalize issue frontmatter and repopulate historical sprint issue assignments | Planning / dashboard correctness | Ready |
| [1003](../ready/1003.md) | High | Normalize issue metadata: add ES edition, language feature, and task type to all issue frontmatter | Planning / dashboard correctness | Ready |
| [687](../ready/687.md) | High | Live-streaming report with run selector | Developer UX | Ready |
| [699](../ready/699.md) | High | Shared compiler pool for test262 | Perf | Ready |
| [832](../ready/832.md) | Medium | Upgrade to TypeScript 6.x for Unicode 16.0 identifiers | 82 skip | Ready |
| [833](../ready/833.md) | Low | Consider sloppy mode support for legacy octal escapes | 16 skip | Ready |

## 8. Proposals and Standards -- Temporal, SharedArrayBuffer, BigInt Arrays, Set Methods, Disposable

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [661](../ready/661.md) | Medium | Temporal API via polyfill | 1,128 tests | Ready |
| [674](../ready/674.md) | Low | SharedArrayBuffer / Atomics | 493 tests | Ready |
| [837](../ready/837.md) | Low | Map/WeakMap upsert (getOrInsert/getOrInsertComputed) | ~110 skip | Ready |
| [838](../ready/838.md) | Low | BigInt64Array / BigUint64Array typed arrays | 19 skip + 25 CE | Ready |
| [988](../ready/988.md) | Low | FinalizationRegistry constructor unsupported in official-scope tests | **23 CE** | Ready |
| [830](../ready/830.md) | Low | DisposableStack extern class missing | **39 FAIL** | Ready |
| [1036](../ready/1036.md) | Medium | DisposableStack/AsyncDisposableStack property-chain access → Wasm null trap | **94 FAIL** | Ready |
| [1037](../ready/1037.md) | Medium | Symbol.dispose / Symbol.asyncDispose not accessible | **30 FAIL** | Ready |
| [1038](../ready/1038.md) | High | Function.prototype.bind not implemented | **70 FAIL** | Ready |
| [671](../backlog/671.md) | Low | with statement support | 272 tests | Backlog |

## 9. Architecture / Refactoring

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [1094](../ready/1094.md) | High | Shrink runtime.ts host boundary — compile-away JS semantics | Standalone/WASI readiness | Ready |
| [1095](../ready/1095.md) | Medium | Eliminate `as unknown as Instr` casts (273 sites) — extend Instr union | Type safety / IR correctness | Ready |
| [1096](../ready/1096.md) | Medium | Isolate environment adapters — remove top-level await from core | Embedding / determinism | Ready |
| [1097](../ready/1097.md) | Low | Remove stale import-helper generator in output.ts | Dead code cleanup | Ready |
| [1098](../ready/1098.md) | Medium | Audit and reduce patch-layer accumulation in codegen (155 workarounds) | Code quality / interaction risk | Ready |
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
| [652](../ready/652.md) | Low | Compile-time ARC / static lifetime analysis | Research | Ready |
| [682](../ready/682.md) | Medium | RegExp standalone engine / embedded backend for non-JS targets | No host in WASI | Ready |
| [1002](../ready/1002.md) | Medium | RegExp js-host mode completion | Remaining host-wrapper and Symbol protocol correctness | Ready |

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
| [1001](../ready/1001.md) | Medium | Preallocate counted `number[]` push loops into dense WasmGC arrays | Landing-page perf / array benchmark | Ready |
| [1004](../ready/1004.md) | Medium | Optimize repeated string concatenation via compile-time folding and counted-loop aggregation | Landing-page perf / string benchmark | Ready |
| [1005](../ready/1005.md) | Medium | Benchmark cold-start startup across Wasmtime, Wasm in Node.js, and native JS in Node.js | Startup benchmarking | Ready |
| [1007](../ready/1007.md) | Medium | Re-run historical test262 checkpoints with the current harness for comparable conformance history | Historical benchmark normalization | Ready |
| [1008](../ready/1008.md) | Medium | Add mobile-first layout support to the playground | Playground mobile UX | Ready |
| [1009](../ready/1009.md) | Medium | Investigate report-page benchmark outliers where Wasm is much slower than JS | Report benchmark analysis | Ready |
| [991](../ready/991.md) | High | Iterator helper generator-reentrancy tests hit 30s compiler timeout | ~90s worker time/run | Ready |
| [993](../ready/993.md) | High | Legacy try-statement tests S12.14_A9/A11/A12_T3 hit 30s compiler timeout | ~90s worker time/run | Ready |
| [992](../ready/992.md) | Medium | Iterator.prototype.take limit-less-than-total hits 30s compiler timeout | 30s worker time/run | Ready |
| [994](../ready/994.md) | Medium | Class static-private-getter test hits 30s compiler timeout | 30s worker time/run | Ready |
| [995](../ready/995.md) | Low | String.prototype.localeCompare 15.5.4.9_CE hits 30s compiler timeout | 30s worker time/run | Ready |
| [996](../ready/996.md) | Low | Array.prototype.toSorted comparefn-not-a-function hits 30s compiler timeout | 30s worker time/run | Ready |

## 10b. Standalone Execution & Wasm-native APIs

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [1099](../ready/1099.md) | High | Standalone execution demo — FizzBuzz on Wasmtime, zero JS host | Production/infra credibility | Ready (depends on #1094) |
| [1035](../ready/1035.md) | High | WASI hello-fs: console.log + node:fs → WASI fd_write | Standalone FS proof | Ready |
| [1100](../ready/1100.md) | Medium | Wasm-native Proxy: meta-object protocol without JS host | Standalone Proxy | Ready |
| [1101](../ready/1101.md) | Low | Wasm-native WeakRef / FinalizationRegistry via WasmGC | Standalone weak refs | Ready |
| [1102](../ready/1102.md) | Medium | Wasm-native eval: ahead-of-time compilation strategy | Standalone eval | Ready |
| [1103](../ready/1103.md) | High | Wasm-native Map, Set, WeakMap, WeakSet using WasmGC | Standalone collections | Ready |
| [1104](../ready/1104.md) | Medium | Wasm-native Error construction and stack traces | Standalone errors | Ready |
| [1105](../ready/1105.md) | High | Wasm-native String method implementations | Standalone string ops | Ready |

## 11. Platform Support

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [639](../ready/639.md) | Critical | Full Component Model adapter (canonical ABI) | Unlocks Fastly, Fermyon | Ready |
| [640](../ready/640.md) | High | WASI HTTP handler | Unlocks serverless edge | Ready |
| [644](../ready/644.md) | Critical | Integrate report into playground | Developer experience | Ready |
| [641](../ready/641.md) | Medium | Shopify Functions template | Best adoption opportunity | Ready |
| [642](../ready/642.md) | Low | Deno/Cloudflare loader plugins | Developer experience | Ready |

---

## Harvest 2026-04-11 (post Sprint 40) — newly filed

Filed by `harvester-post-sprint-40-merge` from post-Sprint-40 test262 baseline (21,190 pass / 19,298 fail). See [harvest summary](../../architecture/harvest-2026-04-11-post-sprint-40.md).

| # | Priority | Issue | Impact | Status |
|---|----------|-------|--------|--------|
| [1047](../ready/1047.md) | High | Private class elements leak onto prototype (hasOwnProperty) | **246 FAIL** | Ready |
| [1049](../ready/1049.md) | Medium | Destructuring default init fn-name-cover: wrong `.name` | **176 FAIL** | Ready |
| [1053](../ready/1053.md) | Medium | `arguments.length` wrong for trailing-comma class method calls | **133 FAIL** | Ready |
| [1054](../ready/1054.md) | Medium | Derived class indirect-eval supercall does not throw SyntaxError | **122 FAIL** | Ready |
| [1050](../ready/1050.md) | Medium | annexB: Extension not observed when binding would early-error | **110 FAIL** | Ready |
| [1056](../ready/1056.md) | Low | DataView `set*` instance methods missing | **89 FAIL** | Ready |
| [1051](../ready/1051.md) | Low | Private static class methods return wrong value | **88 FAIL** | Ready |
| [1052](../ready/1052.md) | Low | Array dstr ignores overridden `Array.prototype[Symbol.iterator]` | **80 FAIL** | Ready |
| [1055](../ready/1055.md) | Low | RegExp pattern modifiers: SyntaxError not thrown | **77 FAIL** | Ready |
| [1048](../ready/1048.md) | Low | async-generator dstr: illegal cast in `__closure_N` | **75 FAIL** | Ready |
| [1057](../ready/1057.md) | Low | `String.prototype.split` result `constructor !== Array` | **68 FAIL** | Ready |

---

## Completed (760+ total)

See `plan/issues/done/log.md` for the full completion log.

**Session 2026-03-19/20**: 97 issues. Pass: 9,270 -> 13,226 (+43%). CE: 14,950 -> 6,894 (-54%).
**Session 2026-03-25**: Pass: 14,720 -> 18,437 (+25%). CE: 4,443 -> 1,657 (-63%).
**Session 2026-03-26**: Pass: 17,602 -> 20,162 (+14.5%).
**Session 2026-03-28**: 18,041 pass, 21,181 fail, 2,284 CE, 6,580 skip. Full error analysis: 13 new runtime issues (#846-#858), 7 new CE issues (#839-#845).
**Session 2026-04-03**: 17,782 pass, 21,178 fail, 2,803 CE, 6,411 skip. Error pattern analysis: 6 new issues (#926-#931).
