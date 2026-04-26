---
id: 45
status: planned
created: 2026-04-23
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: true
---

# Sprint 45

**Date**: TBD (follows sprint 44)
**Baseline**: TBD (inherits from sprint 44 close-out)
**Source**: Triaged out of sprint 44 on 2026-04-23 to keep the week-long sprint
focused on the IR Phase 3/4 critical path, #1153 compiler crashes, and the
highest-impact spec-completeness fixes.

## Goal

Absorb the overflow from sprint 44. Headline themes:

1. **Drain the performance / numeric-inference queue** — #1120, #1121, #1122,
   #1126 form a coherent int32-fast-path block; pair them with benchmarking
   infrastructure (#1005, #1125) so improvements are measurable.
2. **CI baseline-drift hardening** — the 5-issue set (#1076, #1077, #1078,
   #1079, #1080) that was held back from sprint 44 because the IR work could
   not tolerate CI turbulence.
3. **Platform / host surfaces** — WASI, Node builtins, DOM globals, CJS, the
   standalone Wasmtime demo. Grouped because they share the host-import
   architecture.
4. **Second tier spec buckets** — #862, #906, #907, #1025, #1111, #1128. High
   cost / lower per-issue return than what stayed in sprint 44.
5. **Contributor-readiness / maintainability chores** — issue-metadata
   normalization, `as unknown as Instr` cleanup, patch-layer audit, docs page.

Secondary: pick up eval host-import + dynamic-eval (#1006, #1164) once the
static-eval fast path (#1163, staying in sprint 44) lands.

## How this sprint was built

Sprint 44 was groomed on 2026-04-22 from 15 sprint-43 carry-overs plus the IR
Phase 3 chain and fresh spec-completeness work. By 2026-04-23 it had grown to
74 issue files — too many for a single week of agent token budget.

Sprint 45 is the overflow. Sprint 44 keeps 21 issues:

- The IR chain: #1153 (crash-free), #1166, #1167, #1167a, #1167b, #1167c, #1168, #1169
- The ES2015 SingleNameBinding quick win: #1119
- Top-impact spec fixes: #825, #854, #1016, #1148, #1149, #1150, #1152, #1156, #1160, #1161, #1162, #1163

Everything else that was tagged `sprint: 44` but did not fit this week was
moved here. No issues were rescoped, rejected, or deleted — only relocated.

## Triage rules applied (sprint 44 → 45)

- **Blocked, off the sprint-44 IR critical path** → moved: #742
- **Superseded monomorphization issues (rolled into #1167c + #1168)** → moved:
  #744, #773
- **30-second compiler-timeout bucket** → moved as a group to tackle together:
  #991, #992, #993, #994, #995, #996
- **Pure performance / benchmark work** → moved: #1001, #1004, #1005, #1058,
  #1120, #1121, #1122, #1125, #1126
- **CI baseline-drift hardening (5-issue set best done together, not during
  the heavy IR sprint)** → moved: #1076, #1077, #1078, #1079, #1080
- **Contributor-readiness + maintainability chores** → moved: #1000, #1003,
  #1086, #1095, #1096, #1098, #1147
- **npm-library / Node / DOM / WASI platform work** → moved: #1035, #1043,
  #1044, #1045, #1067, #1073, #1075, #1099, #1109
- **Wrapper-object and large remaining spec buckets (high cost, lower
  per-issue return this week)** → moved: #862, #906, #907, #1025, #1111, #1128
- **Eval runtime infrastructure (kept static inlining #1163 in sprint 44)**
  → moved: #1006, #1164
- **Landing page / docs / component work** → moved: #1123, #1147, #1008
- **Large architectural audits (hard+max, need dedicated attention)** → moved:
  #1093, #1094
- **Make-iterable destructuring bug (high priority, but not in-flight and no
  room this week)** → moved: #1135

## Results

TBD

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #742 | Extract and refactor compileCallExpression (3,350 lines) | medium | blocked |
| #1166 | Closed-world integer specialization from literal call sites | high | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #744 | Function monomorphization for polymorphic call sites | high | ready |
| #773 | Monomorphize functions: compile with call-site types, not generic externref | critical | ready |
| #906 | Compile away TDZ tracking for definite-assignment top-level numeric locals | high | ready |
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
| #1008 | Add mobile-first layout support to the playground | medium | ready |
| #1016 | Iterator protocol null access — closed/exhausted iterators crash (500+ FAIL) | high | ready |
| #1035 | WASI hello-world: compile console.log + node:fs write to a standalone native executable | high | ready |
| #1043 | Compile-time `process.env.NODE_ENV` substitution + dead-branch elimination | high | ready |
| #1044 | Node builtin modules as host imports (NODE_HOST_IMPORT_MODULES, node: prefix normalization) | high | ready |
| #1045 | DOM globals as extern classes (DOM_HOST_GLOBALS, queueMicrotask, requestAnimationFrame) | high | ready |
| #1058 | Compile the TypeScript compiler itself to Wasm — self-hosting stress test | high | ready |
| #1067 | Dependency graph as a web component adopting the landing page color scheme | medium | ready |
| #1073 | Scope injection for __extern_eval — pass harness environment bag to preserve caller-visible identifiers | high | ready |
| #1075 | CommonJS module.exports / exports.foo support for compiling .cjs and unmodified npm CJS packages | high | ready |
| #1080 | [umbrella] Fix CI baseline-drift regression gate — main is not self-healing | critical | ready |
| #1093 | Systematic ECMAScript spec conformance audit — review compiled semantics against tc39.es/ecma262 | high | ready |
| #1094 | Shrink runtime.ts host boundary — compile-away JS semantics currently in sidecar runtime | high | ready |
| #1095 | Eliminate `as unknown as Instr` casts — extend Instr union to cover all emitted opcodes | medium | ready |
| #1096 | Isolate environment adapters — remove top-level await and browser/Node probing from core modules | medium | ready |
| #1098 | Audit and reduce patch-layer accumulation in codegen (155 workarounds, special cases, fallbacks) | medium | ready |
| #1099 | Standalone execution demo — compile and run a program on Wasmtime with zero JS host | high | ready |
| #1109 | lodash-es clamp: Wasm validation error in typeof/RegExp codegen path | medium | ready |
| #1120 | Add int32 fast path for bitwise-coerced numeric loops in hot benchmarks | high | ready |
| #1121 | Infer numeric recursive fast path without JSDoc hints on exported entrypoints | high | ready |
| #1122 | Keep standalone recursive numeric benchmark stable across non-run entry exports | high | ready |
| #1123 | Verify landing page claims and code examples against current compiler behavior | high | ready |
| #1125 | Add ComponentizeJS-based StarlingMonkey benchmark setup with Wizer and Weval | high | ready |
| #1126 | Infer when JavaScript number flows can be safely lowered to int32 or uint32 | high | ready |
| #1147 | Add a public Docs page to the site | medium | ready |
| #1169 | IR Phase 4 — migrate full compiler to IR path, retire legacy AST→Wasm codegen | high | ready |
| #1172 | Codebase modularity audit — reduce coupling, improve layering, harden interfaces | high | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1128 | Destructuring TDZ and AnnexB B.3.3 function-in-block hoisting (≥211 tests) | medium | in-progress |

### Review

| Issue | Title | Priority | Status |
|---|---|---|---|
| #862 | Iterator protocol missing on function-declaration binding-pattern params | medium | review |
| #1079 | CI: baseline age stamp + SHA on landing page — make drift observable before crisis | medium | review |
| #1171 | Fix test262 timeout non-determinism — raise testTimeout to 30s, bust CI cache on config change | high | review |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #907 | Replace __init_done runtime guards with start/init entry semantics | high | done |
| #1025 | BindingElement array-pattern default guards still use ref.is_null | high | done |
| #1076 | CI: split merge job into merge-report + regression-gate so push-to-main always refreshes baseline | critical | done |
| #1077 | CI: PR CI should fetch fresh baseline from origin/main at runtime, not read branch-tip copy | high | done |
| #1078 | CI: emergency baseline-refresh workflow_dispatch — discoverable and unconditional promotion | medium | done |
| #1086 | codegen: dedup and memoize bodyUsesArguments to eliminate #96's O(N²) re-walk | medium | done |
| #1111 | Wrapper object constructors: new Number/String/Boolean (648 tests) | medium | done |
| #1135 | `__make_iterable` breaks Wasm-to-Wasm vec→externref destructuring after setExports | high | done |
| #1164 | Dynamic eval via JS host import — compile eval string to ad-hoc Wasm module (~416 tests) | medium | done |
| #1169a | IR Phase 4 Slice 1 — strings, typeof, null/undefined checks through the IR path | high | done |
| #1170 | Move test262 baselines out of Git LFS — eliminate LFS dependency from CI | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
