---
id: 43
status: planned
---

# Sprint 43

**Date**: 2026-04-20 →
**Baseline**: TBD (pending sprint 42 consolidation)
**Target points**: TBD (pending velocity calibration from #1133)

## Carry-over from Sprint 42

All issues below were not started in sprint 42 and carried over. Issues with open PRs from sprint 42 remain in sprint 42 until merged.

## Issues

**Top priority**: #1131 — Middle-end SSA IR: implementation plan (phase 2 of #1124 audit)

<!-- populated from plan/issues/sprints/43/*.md -->

## Results

TBD

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #742 | Extract and refactor compileCallExpression (3,350 lines) | medium | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1131 | Middle-end SSA IR: implementation plan (phase 2 of #1124 audit) | high | ready |
| #744 | Function monomorphization for polymorphic call sites | high | ready |
| #773 | Monomorphize functions: compile with call-site types, not generic externref | critical | ready |
| #854 | Iterator protocol: null next/return/throw methods (126 tests) | high | ready |
| #862 | Iterator protocol missing on function-declaration binding-pattern params | medium | ready |
| #906 | Compile away TDZ tracking for definite-assignment top-level numeric locals | high | ready |
| #907 | Replace __init_done runtime guards with start/init entry semantics | high | ready |
| #991 | Iterator helper generator-reentrancy tests hit 30s compiler timeout | high | ready |
| #992 | Iterator.prototype.take limit-less-than-total hits 30s compiler timeout | medium | ready |
| #993 | Legacy try-statement tests S12.14_A9/A11/A12_T3 hit 30s compiler timeout | high | ready |
| #994 | Class static-private-getter test hits 30s compiler timeout | medium | ready |
| #995 | String.prototype.localeCompare 15.5.4.9_CE hits 30s compiler timeout | low | ready |
| #996 | Array.prototype.toSorted comparefn-not-a-function hits 30s compiler timeout | low | ready |
| #1000 | Normalize issue frontmatter and repopulate historical sprint issue assignments | high | ready |
| #1001 | Preallocate counted number[] push loops into dense WasmGC arrays | medium | ready |
| #1003 | Normalize issue metadata: add ES edition, language feature, and task type to all issue frontmatter | high | ready |
| #1004 | Optimize repeated string concatenation via compile-time folding and counted-loop aggregation | medium | ready |
| #1005 | Benchmark cold-start startup across Wasmtime, Wasm in Node.js, and native JS in Node.js | medium | ready |
| #1006 | Support eval via JS host import | medium | ready |
| #1025 | BindingElement array-pattern default guards still use ref.is_null | high | ready |
| #1035 | WASI hello-world: compile console.log + node:fs write to a standalone native executable | high | ready |
| #1043 | Compile-time `process.env.NODE_ENV` substitution + dead-branch elimination | high | ready |
| #1044 | Node builtin modules as host imports (NODE_HOST_IMPORT_MODULES, node: prefix normalization) | high | ready |
| #1045 | DOM globals as extern classes (DOM_HOST_GLOBALS, queueMicrotask, requestAnimationFrame) | high | ready |
| #1058 | Compile the TypeScript compiler itself to Wasm — self-hosting stress test | high | ready |
| #1067 | Dependency graph as a web component adopting the landing page color scheme | medium | ready |
| #1073 | Scope injection for __extern_eval — pass harness environment bag to preserve caller-visible identifiers | high | ready |
| #1075 | CommonJS module.exports / exports.foo support for compiling .cjs and unmodified npm CJS packages | high | ready |
| #1076 | CI: split merge job into merge-report + regression-gate so push-to-main always refreshes baseline | critical | ready |
| #1077 | CI: PR CI should fetch fresh baseline from origin/main at runtime, not read branch-tip copy | high | ready |
| #1078 | CI: emergency baseline-refresh workflow_dispatch — discoverable and unconditional promotion | medium | ready |
| #1079 | CI: baseline age stamp + SHA on landing page — make drift observable before crisis | medium | ready |
| #1080 | [umbrella] Fix CI baseline-drift regression gate — main is not self-healing | critical | ready |
| #1086 | codegen: dedup and memoize bodyUsesArguments to eliminate #96's O(N²) re-walk | medium | ready |
| #1093 | Systematic ECMAScript spec conformance audit — review compiled semantics against tc39.es/ecma262 | high | ready |
| #1094 | Shrink runtime.ts host boundary — compile-away JS semantics currently in sidecar runtime | high | ready |
| #1095 | Eliminate `as unknown as Instr` casts — extend Instr union to cover all emitted opcodes | medium | ready |
| #1096 | Isolate environment adapters — remove top-level await and browser/Node probing from core modules | medium | ready |
| #1098 | Audit and reduce patch-layer accumulation in codegen (155 workarounds, special cases, fallbacks) | medium | ready |
| #1099 | Standalone execution demo — compile and run a program on Wasmtime with zero JS host | high | ready |
| #1109 | lodash-es clamp: Wasm validation error in typeof/RegExp codegen path | medium | ready |
| #1111 | Wrapper object constructors: new Number/String/Boolean (648 tests) | medium | ready |
| #1119 | Incremental compiler state leak — CompilerPool fork produces ~400 false CEs | high | ready |
| #1119 | ES2015 SingleNameBinding anonymous function/class naming from destructuring context | medium | ready |
| #1120 | Add int32 fast path for bitwise-coerced numeric loops in hot benchmarks | high | ready |
| #1121 | Infer numeric recursive fast path without JSDoc hints on exported entrypoints | high | ready |
| #1122 | Keep standalone recursive numeric benchmark stable across non-run entry exports | high | ready |
| #1123 | Verify landing page claims and code examples against current compiler behavior | high | ready |
| #1125 | Add ComponentizeJS-based StarlingMonkey benchmark setup with Wizer and Weval | high | ready |
| #1126 | Infer when JavaScript number flows can be safely lowered to int32 or uint32 | high | ready |
| #1127 | Nested rest patterns fail to decode even with explicit args — [...[x,y,z]], [...{length}], [...[,]] | medium | ready |
| #1128 | Destructuring TDZ and AnnexB B.3.3 function-in-block hoisting (≥211 tests) | medium | ready |
| #1135 | `__make_iterable` breaks Wasm-to-Wasm vec→externref destructuring after setExports | high | ready |
| #1147 | Add a public Docs page to the site | medium | ready |
| #1152 | Array.prototype higher-order methods fail with 'object is not a function' after PR #195 __get_builtin change (~217 test262 regressions) | high | ready |
| #1160 | Array.from codegen error — property of first arg must be integer (730 tests) | high | ready |
| #1161 | Cannot destructure null/undefined in private class method params (~429 dstr tests) | high | ready |
| #1162 | yield* async — unexpected undefined AST node in compileExpression (~161 tests) | high | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1008 | Add mobile-first layout support to the playground | medium | in-progress |
| #1016 | Iterator protocol null access — closed/exhausted iterators crash (500+ FAIL) | high | in-progress |
| #1148 | Investigate skip:103 regression — Annex B eval-code skip filter | high | in-progress |
| #1149 | Fix null_deref:32 — eval-code direct methods with arguments declare | high | in-progress |
| #1150 | Fix runtime_error:26 + type_error:7 + oob:5 — async destructuring regressions | high | in-progress |
| #1153 | Compiler-internal crashes block ~3,585 test262 tests: commentDirectiveRegEx.exec, constructSigs.reduce, cache.set | critical | in-progress |
| #1156 | Array.prototype method-as-value called with non-function arg produces 'number N is not a function' (~164 tests) | medium | in-progress |

### Review

| Issue | Title | Priority | Status |
|---|---|---|---|
| #825 | Null dereference failures (2,295 runtime failures) | high | review |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #826 | Illegal cast failures (1,276 runtime failures) | high | done |
| #1127 | Class method param destructuring: nested array pattern + initializer throws spurious TypeError | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
