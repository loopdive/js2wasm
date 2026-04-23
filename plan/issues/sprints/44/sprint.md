---
id: 44
status: planned
created: 2026-04-22
updated: 2026-04-23
---

# Sprint 44

**Date**: TBD (follows sprint 43)
**Baseline**: TBD (inherits from sprint 43 close-out)
**Source**: Triaged out of sprint 43 on 2026-04-22 to keep the week-long sprint
focused on IR Phase 3a/3b + critical regressions + highest-impact spec fixes.
On 2026-04-23 sprint 44 was re-triaged again (74 → 21 issues) — everything
outside the IR critical path, the #1153 crash work, the #1119 SingleNameBinding
quick win, and the top-impact spec-completeness fixes (#825, #854, #1016,
#1148, #1149, #1150, #1152, #1156, #1160, #1161, #1162, #1163) was moved to
sprint 45. See `plan/issues/sprints/45/sprint.md` for the overflow and the
triage rules applied.

## Goal

Two headline production-readiness issues lead this sprint:

1. **#1153 — Fix compiler crashes** (~3,585 tests currently blocked by internal
   exceptions on valid input). Hardest blocker for production use.
2. **#1168 — IR frontend widening** (IrType union, LatticeType, box/unbox
   instructions, isPhase1Expr Slice 1). Strategic foundation — unblocks #1166,
   #1167c, and ultimately the full IR migration (#1169).

Secondary: complete the IR Phase 3c chain (#1167c once #1168 lands), drain
ready spec-completeness issues from sprint 43 overflow, close CI baseline-drift
hardening.

## How this sprint was built

This sprint is the overflow from sprint 43. Sprint 43 was groomed to focus on:

1. In-progress / review work (10 issues that could not be abandoned mid-sprint)
2. The actionable IR Phase 3 critical path (#1167a, #1167b, #1166)
3. High-impact spec-completeness fixes with clear fix paths (#1152, #1160, #1161, #1162, #1163)

Everything else that was tagged `sprint: 43` but did not fit into one week of
agent token budget was moved here. No issues were rescoped, rejected, or
deleted — only relocated.

## Triage rules applied

- **Blocked** → moved (can't start anyway): #742, #1167c
- **IR prerequisite chain (hard+max, off the week's critical path)** → moved
  to let Phase 3a/3b run first: #1168
- **Eval runtime infrastructure (hard shim, separate from #1163 inlining)**
  → moved: #1164
- **Superseded monomorphization issues (rolled into #1167c + #1168)** → moved:
  #744, #773
- **30-second compiler-timeout bucket** → moved as a group to tackle together:
  #991, #992, #993, #994, #995, #996
- **Pure performance / benchmark work** → moved: #1001, #1005, #1058, #1120,
  #1121, #1122, #1125, #1126
- **CI baseline-drift hardening (5-issue set best done together, not during
  a heavy IR sprint)** → moved: #1076, #1077, #1078, #1079, #1080
- **Contributor-readiness + maintainability chores** → moved: #1000, #1003,
  #1086, #1095, #1096, #1098, #1147
- **npm-library / Node / DOM / WASI platform work** → moved: #1035, #1043,
  #1044, #1045, #1067, #1073, #1075, #1099, #1109
- **Wrapper-object and large remaining spec buckets (high cost, lower
  per-issue return this week)** → moved: #854, #862, #906, #907, #1006, #1025,
  #1111, #1128
- **Landing page / docs / component work** → moved: #1123, #1147
- **Large architectural audits (hard+max, need dedicated attention)** → moved:
  #1093, #1094
- **Make-iterable destructuring bug (high priority, but not in-flight and no
  room this week)** → moved: #1135
- **Incremental compiler state leak (hard+high, out of week's capacity)**
  → moved: #1119
- **Compile-time string concat folding (performance-adjacent)** → moved: #1004
- **Misc generator model / iterator / playground** → moved: #1067

## Moved issues (55)

### Blocked / prerequisite chain

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #742  | Extract and refactor compileCallExpression (3,350 lines) | medium | medium (blocked) |
| #1167c | IR Phase 3c — monomorphize + tagged-unions | high | hard/max (blocked on #1168) |
| #1168 | IR frontend widening — IrType union/boxed, lattice widening, box/unbox | high | hard/max |

### Superseded by IR Phase 3c

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #744 | Function monomorphization for polymorphic call sites | high | hard/high |
| #773 | Monomorphize functions: compile with call-site types, not generic externref | critical | hard/max |

### Eval runtime infrastructure

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #1006 | Support eval via JS host import | medium | medium/medium |
| #1164 | Dynamic eval via JS host import — compile eval string to ad-hoc Wasm module (~416 tests) | medium | medium/medium |

### 30-second compiler timeouts

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #991 | Iterator helper generator-reentrancy tests hit 30s compiler timeout | high | medium/high |
| #992 | Iterator.prototype.take limit-less-than-total hits 30s compiler timeout | medium | medium/medium |
| #993 | Legacy try-statement tests S12.14_A9/A11/A12_T3 hit 30s compiler timeout | high | medium/high |
| #994 | Class static-private-getter test hits 30s compiler timeout | medium | medium/medium |
| #995 | String.prototype.localeCompare 15.5.4.9_CE hits 30s compiler timeout | low | medium/medium |
| #996 | Array.prototype.toSorted comparefn-not-a-function hits 30s compiler timeout | low | medium/medium |

### Performance / benchmarking

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #1001 | Preallocate counted number[] push loops into dense WasmGC arrays | medium | medium/high |
| #1004 | Optimize repeated string concatenation via compile-time folding | medium | medium/high |
| #1005 | Benchmark cold-start startup across Wasmtime, Wasm in Node.js, native JS | medium | medium/medium |
| #1058 | Compile the TypeScript compiler itself to Wasm — self-hosting stress test | high | hard/max |
| #1120 | Add int32 fast path for bitwise-coerced numeric loops in hot benchmarks | high | medium/high |
| #1121 | Infer numeric recursive fast path without JSDoc hints on exported entrypoints | high | medium/high |
| #1122 | Keep standalone recursive numeric benchmark stable across non-run entry exports | high | medium/high |
| #1125 | Add ComponentizeJS-based StarlingMonkey benchmark setup with Wizer and Weval | high | medium/high |
| #1126 | Infer when JavaScript number flows can be safely lowered to int32 or uint32 | high | hard/high |

### CI / baseline drift hardening

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #1076 | CI: split merge job into merge-report + regression-gate | critical | easy/medium |
| #1077 | CI: PR CI should fetch fresh baseline from origin/main at runtime | high | easy/low |
| #1078 | CI: emergency baseline-refresh workflow_dispatch | medium | easy/low |
| #1079 | CI: baseline age stamp + SHA on landing page | medium | easy/low |
| #1080 | [umbrella] Fix CI baseline-drift regression gate | critical | medium/medium |

### Contributor-readiness / maintainability

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #1000 | Normalize issue frontmatter and repopulate historical sprint issue assignments | high | medium/high |
| #1003 | Normalize issue metadata: add ES edition, language feature, task type to all issues | high | medium/high |
| #1086 | codegen: dedup and memoize bodyUsesArguments to eliminate #96's O(N²) re-walk | medium | easy/low |
| #1095 | Eliminate `as unknown as Instr` casts — extend Instr union to cover all emitted opcodes | medium | medium/high |
| #1096 | Isolate environment adapters — remove top-level await and browser/Node probing from core | medium | easy/medium |
| #1098 | Audit and reduce patch-layer accumulation in codegen (155 workarounds) | medium | medium/high |
| #1147 | Add a public Docs page to the site | medium | easy/medium |
| #1067 | Dependency graph as a web component adopting the landing page color scheme | medium | medium/medium |
| #1123 | Verify landing page claims and code examples against current compiler behavior | high | medium/high |

### Platform / host surfaces

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #1035 | WASI hello-world: compile console.log + node:fs write to a standalone executable | high | medium/high |
| #1043 | Compile-time `process.env.NODE_ENV` substitution + dead-branch elimination | high | medium/medium |
| #1044 | Node builtin modules as host imports (NODE_HOST_IMPORT_MODULES, node: prefix) | high | medium/high |
| #1045 | DOM globals as extern classes (DOM_HOST_GLOBALS, queueMicrotask, requestAnimationFrame) | high | medium/high |
| #1073 | Scope injection for __extern_eval — pass harness environment bag | high | hard/max |
| #1075 | CommonJS module.exports / exports.foo support | high | hard/high |
| #1099 | Standalone execution demo — compile and run a program on Wasmtime with zero JS host | high | hard/max |
| #1109 | lodash-es clamp: Wasm validation error in typeof/RegExp codegen path | medium | hard/high |

### Large spec buckets (high cost / lower per-issue return this week)

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #854 | Iterator protocol: null next/return/throw methods (126 tests) | high | medium/high |
| #862 | Iterator protocol missing on function-declaration binding-pattern params | medium | hard/max |
| #906 | Compile away TDZ tracking for definite-assignment top-level numeric locals | high | medium/high |
| #907 | Replace __init_done runtime guards with start/init entry semantics | high | medium/high |
| #1025 | BindingElement array-pattern default guards still use ref.is_null | high | medium/medium |
| #1111 | Wrapper object constructors: new Number/String/Boolean (648 tests) | medium | medium/— |
| #1128 | Destructuring TDZ and AnnexB B.3.3 function-in-block hoisting (≥211 tests) | medium | hard/high |

### Other

| Issue | Title | Priority | Feasibility |
|---|---|---|---|
| #1093 | Systematic ECMAScript spec conformance audit | high | hard/max |
| #1094 | Shrink runtime.ts host boundary — compile-away JS semantics currently in sidecar | high | hard/max |
| #1119 | Incremental compiler state leak — CompilerPool fork produces ~400 false CEs | high | hard/high |
| #1135 | `__make_iterable` breaks Wasm-to-Wasm vec→externref destructuring after setExports | high | medium/— |

## Results

TBD

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1166 | Closed-world integer specialization from literal call sites | high | blocked |
| #1169 | IR Phase 4 — migrate full compiler to IR path, retire legacy AST→Wasm codegen | high | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #825 | Null dereference failures (2,295 runtime failures) | high | ready |
| #854 | Iterator protocol: null next/return/throw methods (126 tests) | high | ready |
| #1016 | Iterator protocol null access — closed/exhausted iterators crash (500+ FAIL) | high | ready |
| #1119 | ES2015 SingleNameBinding anonymous function/class naming from destructuring context | medium | ready |
| #1148 | Investigate skip:103 regression — Annex B eval-code skip filter | high | ready |
| #1149 | Fix null_deref:32 — eval-code direct methods with arguments declare | high | ready |
| #1150 | Fix runtime_error:26 + type_error:7 + oob:5 — async destructuring regressions | high | ready |
| #1152 | Array.prototype higher-order methods fail with 'object is not a function' after PR #195 __get_builtin change (~217 test262 regressions) | high | ready |
| #1156 | Array.prototype method-as-value called with non-function arg produces 'number N is not a function' (~164 tests) | medium | ready |
| #1161 | Cannot destructure null/undefined in private class method params (~429 dstr tests) | high | ready |
| #1162 | yield* async — unexpected undefined AST node in compileExpression (~161 tests) | high | ready |
| #1163 | Static eval inlining — compile eval(\"fixed string\") at compile time (~208 tests) | high | ready |
| #1167 | SSA IR Phase 3 — optimization passes (meta issue — see 1167a/b/c) | high | ready |
| #1167b | IR Phase 3b — inline-small: inline direct IR calls before lowering | medium | ready |
| #1167c | IR Phase 3c — monomorphize + tagged-unions (blocked on frontend widening) | high | ready |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1153 | Compiler-internal crashes block ~3,585 test262 tests: commentDirectiveRegEx.exec, constructSigs.reduce, cache.set | critical | done |
| #1160 | Array.from codegen error — test262-worker prototype poisoning leak (730 tests) | high | done |
| #1167a | IR Phase 3a — hygiene passes: constant-fold, dead-code, simplify-cfg | high | done |
| #1168 | IR frontend widening — IrType union/boxed, lattice string/object/union, box/unbox instructions | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
