# Sprint 37 — Architectural Foundations: Property Model & Stability

**Date**: 2026-04-04 (sprint 36 wrapping)
**Goal**: Unlock the next major conformance jump by implementing property descriptors and fixing infrastructure stability
**Baseline**: 17,822 pass / 43,120 total (41.3%) — post sprint 36, cache disabled, pre-filter proposals active

**Note**: Sprint 36 branches pending test-and-merge before sprint 37 begins: #919, #921, #927, #931. Tech lead must run test-and-merge on each and update baseline before dispatching sprint 37 devs.

## Context

Sprint 32-35 picked the low-hanging fruit — incremental CE fixes, negative tests, method imports. The remaining ~25K failing tests are dominated by:

- **~5,000 FAIL**: Property descriptor subsystem (#797) — Object.defineProperty, getOwnPropertyDescriptor, configurable/writable/enumerable semantics
- **~2,500 FAIL**: Prototype chain (#799) — method inheritance, constructor chaining, instanceof semantics
- **~1,500 FAIL**: Destructuring parameters (#852) — null_deref + illegal_cast in destructuring bindings

These are **architectural** features that each unlock thousands of tests but require careful design. Sprint 37 focuses on the highest-value one (#797 property descriptors) plus infrastructure stability.

## Task queue

### Phase 1: Infrastructure stability + targeted CE fixes
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 1 | #943 | Test262 runner instability (1,400+ pass variance) | **Critical** — blocks CI | Medium |
| 2 | #945 | __vec_get extern.convert_any on i32 TypedArray elements | **780 CE** — DataView/TypedArray/ArrayBuffer | Medium |
| 3 | #923 | Compiler state leakage between compile() calls | **Critical** — blocks LSP/watch/REPL | Hard |
| 4 | #934 | Array benchmark f64 conversion churn (1.31x slower than JS) | High — benchmark credibility | Medium |

### Phase 2: Property descriptor subsystem (biggest conformance unlock)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 5 | #797 | Property descriptor subsystem (Phase 3 remaining) | **~5,000 FAIL** | Hard — needs architect |
| 6 | #739 | Object.defineProperty correctness | **262 FAIL** | Medium — coordinates #797 |

### Phase 3: Prototype chain (second biggest unlock)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 7 | #799 | Prototype chain (remaining: #802 for dynamic) | **~2,500 FAIL** | Hard — needs architect |
| 8 | #848 | Class computed property / accessor correctness | **1,015 FAIL** | Medium — coordinates #799 |

### Phase 4: High-value ready items
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 9 | #852 | Destructuring params: null_deref + illegal_cast | **1,525 FAIL** | Hard |
| 10 | #828 | Async-gen private static methods: undefined AST node | **154 CE** | Medium |
| 11 | #766 | Symbol.iterator protocol for custom iterables | **~500 FAIL** | Medium |
| 12 | #851 | Iterator close protocol (async-gen remaining) | **~100 FAIL** | Medium |
| 13 | #763 | RegExp runtime method gaps | **~400 FAIL** | Medium |

### Phase 4b: Presentation & DX
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 14 | #946 | Show strict mode compatibility by default on all pages | Medium — DX | Easy |
| 15 | #933 | Migrate report.html to shared web components | Medium — DRY | Medium |

### Phase 5: Refactoring (sprint 36 prereq met — #944 regression fix done)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 14 | #910 | Split expressions.ts into syntax-family modules | High — largest file | Hard |
| 15 | #911 | Split statements.ts into control-flow, vars, destructuring, loops, functions | High | Hard |
| 16 | #912 | Remove circular dependencies from core codegen backend | High — contributor friction | Medium |
| 17 | #913 | Split compiler.ts into validation, orchestration, output | Medium | Medium |

## Dev paths

**Path 1 (Architect → Dev)**: #797 property descriptors — architect spec first, then 2-3 devs implementing subsystem
**Path 2 (Architect → Dev)**: #799 prototype chain — architect spec, then dev implementation  
**Path 3 (Dev, sonnet)**: #943 + #945 + #934 — infrastructure + targeted CE fixes; independent, parallel
**Path 4 (Dev, opus/hard)**: #923 — compiler state leakage (reasoning_effort: max)
**Path 5 (Dev, sonnet)**: #852 + #828 + #766 — high-value ready items, can run in parallel

**Model dispatch rules**: Check `reasoning_effort` in each issue file before dispatching.
- `reasoning_effort: easy/medium/high` → sonnet
- `reasoning_effort: max` → opus (or senior-developer agent)

**Tester protocol**: Spawn a tester agent with `/test-and-merge` for every compiler merge. Never skip. Never dismiss pass count drops as flaky — always bisect with `scripts/diff-test262.ts`.

## Expected impact

| Area | Est. tests fixed |
|------|-----------------|
| #945 __vec_get i32 fix | **~780 CE → PASS or FAIL** |
| #797 property descriptors | ~3,000-5,000 |
| #799 prototype chain | ~1,500-2,500 |
| #852 destructuring | ~800-1,200 |
| #828 async-gen private static | ~154 CE |
| #766 Symbol.iterator | ~300-500 |
| Infrastructure (#943, #923, #934) | reliability + perf |
| Sprint 36 pending merges (#919, #921, #927, #931) | ~200-400 PASS |
| **Total potential** | **~6,700-10,500** |

If #797 and #799 both land, conformance could reach 55-60%. The infrastructure fixes (#943, #945) also need to come first since they affect baseline accuracy.

## Prerequisites

- #797 and #799 both need **architect specs** before dev work
- #943 (runner stability) should be fixed early so test262 validation is reliable
- Sprint 36 refactoring (#910-#913) would make #797/#799 implementation cleaner but is not blocking

### Phase 6: Session issues (#940-#953)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 20 | #940 | String.fromCodePoint WASI helper | Low | Easy |
| 21 | #941 | Equiv tests for isNaN/isFinite | Low | Easy |
| 22 | #946 | Show strict mode compatibility by default | Medium | Easy |
| 23 | #947 | Calendar WAT: 6 codegen inefficiencies | Medium | Medium |
| 24 | #948 | Systematic WAT analysis of all equiv tests | High | Medium |
| 25 | #949 | Document JS-to-Wasm landscape and related work | Medium | Easy |
| 26 | #950 | Compile error on calls with fewer args than TS signature | Medium | Medium |
| 27 | #951 | Unused imports cause const declaration error | Medium | Medium |
| 28 | #953 | Add Wasm validation pass to compilation tests | High | Easy |

## Results

**Baseline**: 17,822 pass / 43,120 (41.3%)
**Current**: 18,288 pass / 43,120 (42.4%)
**Delta**: +466

| Issue | Status | Delta |
|-------|--------|-------|
| #945 vec_get i32 | Merged ✓ | -780 CE (targeted fix) |
| #797 architect spec | Done ✓ | 6 work items written |
| #797 WI1+WI2+WI4 | Merged ✓ | getOwnPropertyDescriptor, keys enumerability, propertyIsEnumerable |
| #797 WI3+WI6 | Merged ✓ | getOwnPropertyNames/Symbols, Object.create |
| #923+#943 state leak | Done ✓ | Compiler proven idempotent, _ensureStructPending fixed |
| #931 error reporting | Merged ✓ | 132 ctx.errors.push migrated to reportError |
| #919 async gen fix | Merged ✓ | Exclude async generators from Promise.resolve wrapping |
| #952 regression fix | Merged ✓ | +1,040 pass — removed 5 overly aggressive #927 checks |

## Retrospective

(To be filled after sprint completion)
