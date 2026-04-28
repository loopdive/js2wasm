---
title: "Sprint 42 — First npm package compiles and runs E2E in Wasm"
status: done
sprint: 42
goal: spec-completeness
---

# Sprint 42 — First npm package compiles and runs E2E in Wasm

**Planned start**: after Sprint 41 closes
**Starting baseline (projected)**: ~23,000-23,500 pass / 43,171 total (~53-55%)
**Goal**: a real npm package compiles via `compileProject`, instantiates, and produces correct output
**Secondary goal**: continue pass-rate push with Sprint 41 overflow + prettier follow-ups
**Duration**: 1 sprint (3 devs)

## The milestone

**"First npm package runs in Wasm"** is a project-defining demo. It transforms js2wasm from "passes test262 tests" into "compiles real-world code." The acceptance criterion is concrete: a documented npm package, compiled to Wasm, produces correct output for a set of inputs, reproducible in CI.

## Target package: lodash-es

### Why lodash-es

| Criterion | lodash-es | nanoid | ms | mitt |
|-----------|-----------|--------|-----|------|
| Module format | ESM | ESM | CJS | ESM |
| Host API deps | None | crypto, Buffer | None | None (but uses Map) |
| Complexity | Pure compute | Crypto pool mgmt | String/number parsing | Event emitter w/ Map |
| Blocking issues | #1074 only | crypto host import | #1074 + #1075 | #1071 (for-of Map) |
| Demo value | High (iconic lib) | Medium | Low | Low |
| Already stress-tested | Yes (#1031) | No | No | No |
| Codegen fixes merged | #1060-#1063 all done | None | None | None |

**lodash-es wins on every axis.** The stress test (#1031) already identified and fixed 4 of 5 blockers (#1060, #1061, #1062, #1063 all merged). The single remaining blocker is **#1074** (export default surfacing). Once that lands, `lodash-es/identity.js` should compile and run — the fastest path from "broken" to "working npm package."

### Tier 1 acceptance: 3 functions work

| Function | Input | Expected | Tests |
|----------|-------|----------|-------|
| `identity(x)` | `identity(42)` | `42` | identity, type preservation |
| `clamp(n, lower, upper)` | `clamp(5, 0, 10)` | `5` | boundary, NaN, negative |
| `add(a, b)` | `add(3, 4)` | `7` | basic arithmetic |

### Tier 2 acceptance: 10 functions work

Extend to: `constant`, `noop`, `toInteger`, `toNumber`, `toString`, `isNaN`, `isFinite`, `isNumber` — all pure compute, no iteration, no prototype chain.

### Tier 3 stretch: iteration-dependent functions

`map`, `filter`, `forEach`, `find`, `reduce` — these need the iterator protocol (#1016) and array destructuring fixes from Sprint 41 to work on lodash's internal iteration paths.

## Context: what changed since the original Sprint 42 plan

The original Sprint 42 was written when Sprint 41 was scoped as non-error work (stress tests, perf, infra). Sprint 41 was repurposed as a pass-rate push sprint, so:

- **Sprint 41 overflow** (pass-rate issues that didn't land) carries forward into Sprint 42
- **Non-error work** (stress tests, perf, infra, refactor) that was deferred from Sprint 41 remains deferred — now Sprint 43
- **The npm package goal** is new and becomes Sprint 42's primary mission
- Issues from the old Sprint 42 plan (#1119, #821, #825, #826, #854, #1117, #862, #1111, #1037, #906, #907) are reassessed below — some are still relevant, others are already done or re-scoped

### Old Sprint 42 issues — disposition

| Old # | Title | Disposition |
|-------|-------|-------------|
| #1119 | CompilerPool incremental state leak | **KEEP** if still valid — verify before dispatch |
| #821 | BindingElement null guard | **Subsumed** into #1016 (iterator protocol) per Sprint 41 investigation |
| #825 | Null dereference failures | **KEEP** as stretch — still a large bucket |
| #826 | Illegal cast failures | **Verify** — was marked Done in dep graph (255 tests fixed). Check if still open |
| #854 | Iterator protocol null methods | **Verify** — was marked Done in dep graph |
| #1117 | Expected TypeError wrong type | **Overlaps** with #1092 (Sprint 41). Keep if #1092 didn't land |
| #862 | Empty error messages | **Verify** — was marked Done in dep graph |
| #1111 | Wrapper object constructors | **KEEP** as stretch — high-value but large |
| #1037 | Symbol.dispose | **KEEP** as stretch |
| #906 | TDZ compile-away | **DEFER** to Sprint 43 — perf, not pass-rate |
| #907 | __init_done elimination | **DEFER** to Sprint 43 — perf, not pass-rate |

## Sprint 41 overflow (carry-over)

Issues that didn't land in Sprint 41 carry forward. These still have direct pass-rate impact.

| # | Title | Impact | Effort | Notes |
|---|-------|--------|--------|-------|
| **#1053** | arguments.length rework | 133 FAIL | M | Needs #1085 first; reverted work |
| **#1016** | Iterator protocol (split approach) | 500+ FAIL | H | Only attempt class-dstr slice (#1016a) |
| **#990** | Early-error residuals | 327 FAIL | H | Continues from Sprint 41's #1091 work |
| **#1006** + **#1073** | Eval host import + scope injection | 107+ pass | M+H | If #1006 didn't land in Sprint 41 |

Plus any Phase 2 issues from Sprint 41 that didn't get picked up — they remain in the ready queue ordered by impact.

## Phase-ordered task queue

### Phase 0: The critical enabler (Day 1 — must ship first)

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 0 | **#1074** | Surface ESM `export default` as Wasm function export | **Blocks ALL npm packages** | M | Single remaining blocker for lodash-es. Walk ExportAssignment nodes, emit under both declaration name and `default`. Currently lodash-es/identity.js produces a 102-byte empty binary with zero exports |

**Nothing else in Sprint 42 matters if #1074 doesn't land.** Assign to the strongest dev, Day 1, top priority.

### Phase 1: lodash-es Tier 1 demo (Days 1-2)

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 1 | **#1074** | (see above) | — | — | — |
| 2 | **NEW** | lodash-es Tier 1 E2E harness | Demo | S | Write `scripts/lodash-es-e2e.ts`: install lodash-es, compile identity/clamp/add via compileProject, instantiate, assert correct output. Run in CI |
| 3 | **NEW** | lodash-es Tier 2 expansion | Demo | S | Extend harness to 10 pure-compute functions. File issues for any new failures discovered |

### Phase 2: Pass-rate push from Sprint 41 overflow (Days 2-4)

Continue shipping medium-effort issues that flip tests. These run in parallel with Phase 1.

| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 4 | Sprint 41 overflow | Whichever Phase 2 issues didn't land | variable | M |
| 5 | **#1053** | arguments.length rework (if not done in Sprint 41) | 133 FAIL | M |
| 6 | **#1016a** | Iterator protocol — class dstr slice only | ~60 FAIL | M |
| 7 | **#1119** | CompilerPool incremental state leak (if still valid) | ~400 CE | H |

### Phase 3: Prettier follow-ups (Days 3-5)

These unblock prettier/doc.mjs instantiation — a second real-world demo. Ordered by blocking severity.

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 8 | **#1068** | Parser: 'await' as label identifier | Unblocks index.mjs compile | M | 4 diagnostics, parser rule relaxation |
| 9 | **#1072** | Return-type coercion f64 → externref | Unblocks doc.mjs instantiation | H | Call-expression post-emit coerce hook |
| 10 | **#1069** | Object literal → struct inference | 11 diagnostics in doc.mjs | H | Anonymous boxed-anyref struct fallback |
| 11 | **#1071** | for-of non-array iterables (Map/Set/generator) | 2 diagnostics + broad test262 impact | H | Widens for-of path beyond T[] |
| 12 | **#1070** | Intl.ListFormat constructor | 2 diagnostics | M | Extern class table addition |

### Phase 4: CJS support + reapplied work (stretch — only if Phases 0-2 ship)

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 13 | **#1075** | CommonJS module.exports / require support | Unblocks lodash (CJS), ms, most npm | H | 4-phase approach: recognize CJS forms → require in module graph → exports aliasing → ESM interop |
| 14 | **#1065** | Register Array as declared global | 68 FAIL + npm patterns | M | Needed for `.constructor === Array` comparisons |
| 15 | **#1057** | String.prototype.split constructor (if not done in Sprint 41) | 68 FAIL | S | Reapply of reverted PR #100 (9 LOC) |

### Phase 5: Compiler architecture hardening (from external review — background)

Filed from external compiler engineer review (2026-04-12). These address structural risks flagged as blockers for production/standalone readiness.

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 16 | **#1094** | Shrink runtime.ts host boundary | Standalone/WASI readiness | H | Audit + compile-away 3 host functions. Key for non-browser story |
| 17 | **#1095** | Eliminate `as unknown as Instr` casts (273→≤50) | IR type safety | L | Extend Instr union, mechanical but wide. Improves dead-elim + peephole |
| 18 | **#1096** | Isolate env adapters from core modules | Embedding/determinism | S | Remove top-level await + env probing from checker/resolve |
| 19 | **#1097** | Remove stale import-helper generator in output.ts | Dead code cleanup | XS | Verify unused, delete ~200 LOC |
| 20 | **#1098** | Audit codegen patch-layer accumulation (155 workarounds) | Code quality | M | Top 3 files: calls.ts (39), assignment.ts (16), property-access.ts (16) |
| 21 | **#1099** | Standalone execution demo — FizzBuzz on Wasmtime, zero JS | Production credibility | H | Depends on #1094. Proves standalone story end-to-end |
| 22 | **#1013** | Split codegen/index.ts (5,690 LOC remaining) | Maintainability | M | Already existed — now validated by external review |

### Phase 6: CI hardening (background — assign to whoever has gaps)

Deferred from Sprint 41. Important for pipeline stability but doesn't flip tests.

| Order | Issue | Title | Effort |
|-------|-------|-------|--------|
| 23 | **#1076** | Split merge job into report + gate | M |
| 24 | **#1077** | PR CI fetches current main baseline | M |
| 25 | **#1078** | Emergency dispatch hardening | S |
| 26 | **#1079** | Baseline age stamp on landing page | S |
| 27 | **#1080** | CI hardening umbrella | tracking |
| 28 | **#1085** | bodyUsesArguments iterative (if not done in Sprint 41) | S |

### Phase 7: Wasm-native API implementations (standalone milestone)

These replace JS host dependencies with Wasm-native implementations. Each is independently valuable — prioritize by impact on the standalone execution story (#1099).

| Order | Issue | Title | Impact | Effort | Notes |
|-------|-------|-------|--------|--------|-------|
| 29 | **#1103** | Wasm-native Map, Set, WeakMap, WeakSet | Standalone collections | H | WasmGC struct-based hash maps. Unblocks standalone programs using collections |
| 30 | **#1105** | Wasm-native String methods on i16 arrays | Standalone string ops | H | Tier 1 (no RegExp): indexOf, slice, trim, split, etc. Broad test262 impact |
| 31 | **#1104** | Wasm-native Error construction | Standalone errors | M | Error structs + all 7 subclasses. Enables standalone throw/catch |
| 32 | **#1100** | Wasm-native Proxy meta-object protocol | Standalone Proxy | H | Vtable dispatch on property ops. Large scope but high value |
| 33 | **#1102** | Wasm-native eval (AOT compilation) | Standalone eval | H | Constant-string eval compiled at build time. Dynamic eval → compile error |
| 34 | **#1101** | Wasm-native WeakRef / FinalizationRegistry | Standalone weak refs | H | Depends on WasmGC weak ref support. Lowest standalone priority |
| 35 | **#682** | RegExp standalone engine | Standalone RegExp | H | Already tracked. Enables #1105 Tier 2 string methods |

### Phase 8: Investigation (background)

| Order | Issue | Title | Notes |
|-------|-------|-------|-------|
| 36 | **#1093** | Systematic ECMAScript spec conformance audit | Run as background investigation; file issues for Sprint 43 |
| 37 | **#1088** | Assertion diagnostic regex fix | S effort, improves triage quality |

## Dependency graph for Sprint 42

```
#1074 (export default) ──→ lodash-es Tier 1 demo
                        ──→ lodash-es Tier 2 expansion
                        ──→ #1075 (CJS support, depends on #1074)

#1068 (await label) ──→ prettier/index.mjs compile
#1072 (f64→externref) ──→ prettier/doc.mjs instantiation
#1069 (struct inference) ──→ prettier/doc.mjs cleaner compile
#1071 (for-of iterables) ──→ prettier + broad test262 impact

#1085 (bodyUsesArguments) ──→ #1053 (arguments.length rework)

Sprint 41 overflow issues are independent of the npm chain.

#1094 (shrink runtime.ts) ──→ #1099 (standalone demo on Wasmtime)
#682 (RegExp standalone) ──→ #1105 Tier 2 (match, replace, search)
#1101 (WeakRef) ──→ #1103 WeakMap/WeakSet (strong-ref fallback works without #1101)
#1103, #1104, #1105 are independent of each other
#1100 (Proxy) and #1102 (eval) are independent of everything
```

## Dev assignment strategy

**Dev A** (npm chain lead): #1074 → lodash-es harness → lodash-es Tier 2 → #1075
**Dev B** (pass-rate + prettier): Sprint 41 overflow → #1068 → #1072 → #1069
**Dev C** (pass-rate + CI): Sprint 41 overflow → #1053 → #1071 → CI hardening (#1076-#1079)

## Acceptance criteria

### Must-have
- [ ] **lodash-es Tier 1**: `identity(42) === 42`, `clamp(5, 0, 10) === 5`, `add(3, 4) === 7` — all via `compileProject` → `WebAssembly.instantiate` → function call
- [ ] **Reproducible demo**: `scripts/lodash-es-e2e.ts` runs green in CI (GitHub Actions)
- [ ] **#1074 landed**: ESM `export default` surfaces as Wasm function exports
- [ ] **Pass-rate ≥ 53.5%**: baseline at sprint close is at least 23,100 / 43,171

### Should-have
- [ ] **lodash-es Tier 2**: ≥8 of 10 pure-compute functions produce correct output
- [ ] **prettier/doc.mjs instantiates**: #1072 landed, binary passes `WebAssembly.validate`
- [ ] **≥4 Sprint 41 overflow issues merged**
- [ ] **CI hardening**: at least #1076 + #1077 landed (structural baseline-drift fixes)

### Nice-to-have
- [ ] **CJS support (#1075)**: `lodash/identity.js` (CJS build) compiles via `compileProject`
- [ ] **prettier/index.mjs compiles**: #1068 landed, full bundled core reaches codegen stage
- [ ] **lodash-es Tier 3**: at least one iteration-dependent function (map/filter) works
- [ ] **Pass-rate ≥ 55%**: 23,700+ / 43,171

## Non-goals

- Full lodash-es compatibility (hundreds of functions) — Tier 1-2 is the target
- Prettier self-format diff (byte-for-byte comparison) — blocked until doc.mjs instantiates (#1072)
- React or axios stress tests — still blocked on #1043/#1044/#1045 preconditions
- TypeScript self-hosting (#1058) — blocked on #1042/#1044/#1046
- WASI deliverable (#1035) — deferred, no pass-rate impact
- Performance work (#1001, #1004, #1005, #906, #907) — deferred to Sprint 43
- Codegen refactor (#1013) — deferred to Sprint 43
- Planning-data normalization (#1000, #1003) — deferred to Sprint 43

## Risks

1. **#1074 is harder than expected**: if export default surfacing requires changes to the export collection AND the codegen reachability analysis (empty 102-byte binary suggests codegen skips unreachable code), it could be M+ effort. Mitigation: architect spec if blocked >4 hours.

2. **lodash-es functions hit new codegen bugs**: even with #1060-#1063 merged, the Tier 1 functions may reveal new type-coercion or control-flow issues in the clamp/add paths. Mitigation: file narrow issues, don't try to fix everything in one PR.

3. **Sprint 41 overflow is large**: if Sprint 41 only ships 50% of its issues, Sprint 42 inherits a heavy carry-over. Mitigation: the npm chain (Phase 0-1) is independent of pass-rate work and can run in parallel.

4. **Prettier follow-ups (#1069, #1071, #1072) are Hard**: struct inference and for-of iterables are architectural changes. Mitigation: they're Phase 3, not blocking the lodash demo. Ship them if capacity allows.

5. **CJS (#1075) is a multi-phase feature**: full CJS support is Hard. Mitigation: it's Phase 4 stretch — the lodash-es ESM path doesn't need it. Only attempt if Phases 0-2 ship cleanly.

## What success looks like

At the end of Sprint 42:
- **Demo-ready**: `npx ts-node scripts/lodash-es-e2e.ts` compiles 3-10 lodash-es functions to Wasm and runs them correctly
- **Landing page update**: "First npm package (lodash-es) compiles and runs in Wasm" announcement
- **Pass rate**: 53.5-55% (Sprint 41 gains preserved + Sprint 42 overflow fixes)
- **Pipeline stable**: CI baseline-drift structural fixes landed
- **Sprint 43 seeded**: #1093 spec audit has filed 5-10 targeted issues from the remaining 45% failure space

## Sprint Progress (live — updated 2026-04-12)

### Merged today
| PR | Issue | Delta | Notes |
|----|-------|-------|-------|
| #131 | #1074 export default fn | 0 | clean |
| #133 | #1106 CI baseline-refresh fix | — | infra |
| #130 | #1057 vec constructor short-circuit | +1 | |
| #136 | #1107 lodash-es E2E harness | 0 | Tier 1 harness + identity/noop/stubTrue/stubFalse pass |
| #137 | #1071 for-of non-array iterables | 0 | Map/Set/generator for-of fixed |
| #138 | #1072 f64 externref coercion | 0 | |
| #139 | #1069 struct inference externref | +11 | |

### Baseline: 22,412 → 22,423 (+11) so far

### In CI (awaiting results)
- PR #132 #1068 await-label: -1 regression (needs fix, dev-1 notified)
- PR #134 #1016 iterator class dstr: test262 run queued
- PR #135 #990 early errors: test262 run pending
- PR #140 #1108 export default variable: merge shard reports queued
- PR #141 #1070 Intl.ListFormat: test262 run pending
- PR #142 #1097 dead code removal: 14/18 shards
- PR #143 #1088 assertion diagnostic: 7/18 shards

### Active dev work
| Dev | Task | Issue |
|-----|------|-------|
| dev-A | #20 | #825 null dereference (1,754) |
| dev-1 | #19 | #1117 Expected TypeError (136) + fix PR #132 |
| dev-2 | #17 | #1109 lodash-es clamp Wasm validation |
| dev-3 | #18 | #826 illegal cast (1,276) |
| dev-B | #15 | #862 empty error messages (212) |
| dev-C | — | #854 iterator null methods (126) |

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue frontmatter. Update issue `sprint` / `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1132 | Publish compiler as @loopdive/js2 on npm + JSR | high | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #907 | Replace __init_done runtime guards with start/init entry semantics | high | done |
| #990 | Remaining early-error gaps after detectEarlyErrors(): reserved words, module grammar, using, ASI | high | done |
| #991 | Iterator helper generator-reentrancy tests hit 30s compiler timeout | high | done |
| #992 | Iterator.prototype.take limit-less-than-total hits 30s compiler timeout | medium | done |
| #993 | Legacy try-statement tests S12.14_A9/A11/A12_T3 hit 30s compiler timeout | high | done |
| #994 | Class static-private-getter test hits 30s compiler timeout | medium | done |
| #995 | String.prototype.localeCompare 15.5.4.9_CE hits 30s compiler timeout | low | done |
| #996 | Array.prototype.toSorted comparefn-not-a-function hits 30s compiler timeout | low | done |
| #1001 | Preallocate counted number[] push loops into dense WasmGC arrays | medium | done |
| #1005 | Benchmark cold-start startup across Wasmtime, Wasm in Node.js, and native JS in Node.js | medium | done |
| #1006 | Support eval via JS host import | medium | done |
| #1017 | Null pointer dereferences and illegal casts in compiled code (504 FAIL) | high | done |
| #1036 | DisposableStack/AsyncDisposableStack property-chain access produces Wasm null trap (94 FAIL) | medium | done |
| #1037 | Symbol.dispose / Symbol.asyncDispose not accessible (30 FAIL) | medium | done |
| #1038 | Function.prototype.bind not implemented (70 FAIL) | high | done |
| #1047 | Instance fields leak onto prototype via _wrapForHost struct-field enumeration | high | done |
| #1057 | String.prototype.split result constructor !== Array | low | done |
| #1067 | Dependency graph as a web component adopting the landing page color scheme | medium | done |
| #1071 | codegen: for-of requires an array expression — blocks iteration over Map/Set/iterator in bundled JS | high | done |
| #1073 | Scope injection for __extern_eval — pass harness environment bag to preserve caller-visible identifiers | high | done |
| #1077 | CI: PR CI should fetch fresh baseline from origin/main at runtime, not read branch-tip copy | high | done |
| #1088 | test262: assertion location diagnostic misses verifyProperty/verifyEqualTo — 273 tests report 'found 0 asserts in source' | medium | done |
| #1094 | Shrink runtime.ts host boundary — compile-away JS semantics currently in sidecar runtime | high | done |
| #1097 | Remove stale import-helper generator path in compiler/output.ts | low | done |
| #1106 | CI baseline-refresh bot wipes plan/ and .claude/memory/ on every run | high | done |
| #1107 | lodash-es Tier 1 E2E harness — identity, clamp, add compile and run | critical | done |
| #1108 | lodash-es add: export default of HOF closure result not surfaced as Wasm export | high | done |
| #1117 | Expected TypeError but got wrong error type (136 tests) | medium | done |
| #1123 | Verify landing page claims and code examples against current compiler behavior | high | done |
| #1124 | Audit current codegen IR and, if needed, define a minimal SSA middle-end | high | done |
| #1136 | Array.prototype.flat() and flatMap() not implemented | medium | done |
| #1137 | ES2023 array methods: toReversed, toSorted, toSpliced, with — not implemented | medium | done |
| #1138 | Destructuring: unresolvable defaults throw ReferenceError instead of being undefined | high | done |
| #1139 | Destructuring: TypeError not thrown on null/undefined source (RequireObjectCoercible) | high | done |
| #1140 | Array methods .call() with array-like receiver not supported | medium | done |
| #1141 | Object.defineProperties: descriptor shape not validated per ECMA-262 §10.1 | medium | done |
| #1142 | Class method .call()/.apply() missing brand-check on thisArg | medium | done |
| #1143 | Array callback arg push not gated on paramTypes.length — extra args emitted unconditionally | low | done |
| #1144 | Static class elements: this.#priv access inside static methods uses wrong receiver | medium | done |
| #1145 | Async generator: undefined tuple elements promote to f64, corrupting sNaN sentinel | medium | done |
| #1146 | for-of: nested rest binding patterns not decoded (825 ary-rest-rest cluster) | medium | done |

<!-- GENERATED_ISSUE_TABLES_END -->
## Retroactive Sprint 42 Completions

_Issues confirmed merged to main during Sprint 42 but not in the auto-generated table above (frontmatter sprint field not updated). Added 2026-04-19._

| Issue | Title | PR | Notes |
|---|---|---|---|
| #907 | Replace `__init_done` guards with `_start` export | #177 | Was originally deferred; shipped mid-sprint |
| #991 | Timeout fixes — close(fixed by #1085) | #197 | Closed as fixed by iterative walker |
| #992 | Timeout fixes — verified | #200 | Closed as fixed |
| #993 | Timeout fixes — verified | #200 | Closed as fixed |
| #994 | Static private getter via `this` in static methods | #158 | Timeout root cause fixed |
| #997 | BigInt → toPrimitive path | #120 | Sprint 41 carry-over, merged in sprint 42 |
| #1005 | Cold-start benchmark: Wasm-in-Node vs JS-in-Node | bench PR | Performance measurement infra |
| #1018 | `getOwnPropertyDescriptor` null guard | #122 | Sprint 41 carry-over |
| #1024 | Destructuring rest holes | #124 | Sprint 41 carry-over |
| #1026 | Built-in constructor `.prototype` access via `__get_builtin`+`__extern_get` | #195 | 86 test262 improvements |
| #1034 | Prettier stress test | #109 | Sprint 41 carry-over |
| #1035 | WASI `writeFileSync` → `path_open`+`fd_write`+`fd_close` | #176 | WASI filesystem |
| #1044 | Recognize Node.js builtin modules as host imports | #174 | npm compatibility |
| #1053 | `arguments.length` — trailing comma inflation fix | #129, #189 | Sprint 41 carry-over + follow-up |
| #1063 | Lodash closure ref | #110 | Sprint 41 carry-over |
| #1067 | `<dep-graph>` interactive dependency graph web component | dep-graph PR | Dashboard infra |
| #1069 | Object literal → struct inference externref | #139 | Sprint 41 carry-over |
| #1072 | Return-type coercion f64 → externref | #138 | Sprint 41 carry-over |
| #1073 | Eval scope injection — `__extern_eval` JS-side harness | #183 | +107 test262 |
| #1074 | Surface ESM `export default` as Wasm function export | #131 | Primary sprint goal |
| #1075 | CommonJS `module.exports`/`require` support | #180 | CJS compatibility |
| #1078 | Emergency baseline-refresh `workflow_dispatch` | #1078 PR | CI hardening |
| #1079 | Baseline age stamp + SHA on dashboard | #1079 PR | CI hardening |
| #1085 | `bodyUsesArguments` iterative walker | #127 | Sprint 41 carry-over |
| #1086 | Extract and memoize `bodyUsesArguments` | #156 | Refactor |
| #1090 | `OrdinaryToPrimitive` — host toPrimitive before fallback | #123 | Sprint 41 carry-over |
| #1091 | Early errors residuals | #121 | Sprint 41 carry-over |
| #1092 | Wrong error type fixes | #125 | Sprint 41 carry-over |
| #1109 | Prevent double-shifting + skip hard type errors in allowJs | #153 | Codegen fix |
| #1119 | CompilerPool incremental state leak | #198 | ~400 CE fixed |
| #1122 | WASI: prevent `_start` calling parameterized `main()` | #175 | WASI correctness |
| #1123 | Landing page audit | #178 | Docs |
| #1127 | Nested rest binding decode | #224 | Destructuring |
| #1128 | `toPrimitive` TypeError on non-callable @@toPrimitive | #181 | +spec compliance |
| #1132 | Publish compiler as `@loopdive/js2` on npm + JSR | npm PR | Package release |
| #1134 | Loose equality `null==undefined`, `bool==number` for externref | loose-eq PR | +conformance |
| #1136 | `Array.prototype.flat()` and `flatMap()` | #190 | ES2019 methods |
| #1137 | ES2023 array methods: `toReversed`, `toSorted`, `toSpliced`, `with` | #192 | 18/89 test262 |
| #1138 | Destructuring: unresolvable defaults throw `ReferenceError` (+115 test262) | #216 | |
| #1139 | Destructuring: `TypeError` on null/undefined source (RequireObjectCoercible) | #225 | |
| #1140 | Array methods `.call()` with array-like receiver | #223 | |
| #1141 | `Object.defineProperties`: descriptor shape validation per ECMA-262 §10.1 | #226 | |
| #1142 | Brand-check `thisArg` on class method `.call()`/`.apply()` | #227 | |
| #1143 | Array callback arg push not gated on `paramTypes.length` | #228 | |
| #1144 | Static class elements: `this.#priv` access in static methods | #204 | |
| #1145 | Async-gen: undefined tuple elements promote to f64, corrupting sNaN | #205 | |
| #1146 | For-of nested rest binding patterns (#825 ary-rest-rest cluster) | #209 | Sub-issue of #825 |
## Sprint 42 Final Results

**Closed**: 2026-04-21
**Final baseline**: 24,483 / 43,172 pass = **56.7%**
**Issues completed**: 40 done, 1 backlog (#1111 deferred)
**Carried to Sprint 43**: #825 (null deref, partial), #826 (illegal cast, partial), #742 (blocked), #1111 (backlog)
**Key merges this sprint**: #144 (Symbol.iterator on vecs), #160 (CI split), #231 (IR scaffold Phase 1)