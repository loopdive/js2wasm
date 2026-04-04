# Sprint 37 — Architectural Foundations: Property Model & Stability

**Date**: TBD (after sprint 36 completes)
**Goal**: Unlock the next major conformance jump by implementing property descriptors and fixing infrastructure stability
**Baseline**: TBD (sprint 36 result, ~17,717 pass / 41.1%)

## Context

Sprint 32-35 picked the low-hanging fruit — incremental CE fixes, negative tests, method imports. The remaining ~25K failing tests are dominated by:

- **~5,000 FAIL**: Property descriptor subsystem (#797) — Object.defineProperty, getOwnPropertyDescriptor, configurable/writable/enumerable semantics
- **~2,500 FAIL**: Prototype chain (#799) — method inheritance, constructor chaining, instanceof semantics
- **~1,500 FAIL**: Destructuring parameters (#852) — null_deref + illegal_cast in destructuring bindings

These are **architectural** features that each unlock thousands of tests but require careful design. Sprint 37 focuses on the highest-value one (#797 property descriptors) plus infrastructure stability.

## Task queue

### Phase 1: Infrastructure stability (unblocks reliable testing)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 1 | #943 | Test262 runner instability (1,400+ pass variance) | **Critical** — blocks CI | Medium |
| 2 | #923 | Compiler state leakage between compile() calls | **Critical** — blocks LSP/watch/REPL | Hard |
| 3 | #934 | Array benchmark f64 conversion churn (1.31x slower than JS) | High — benchmark credibility | Medium |

### Phase 2: Property descriptor subsystem (biggest conformance unlock)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 4 | #797 | Property descriptor subsystem (Phase 3 remaining) | **~5,000 FAIL** | Hard — needs architect |
| 5 | #739 | Object.defineProperty correctness | **262 FAIL** | Medium — coordinates #797 |

### Phase 3: Prototype chain (second biggest unlock)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 6 | #799 | Prototype chain (remaining: #802 for dynamic) | **~2,500 FAIL** | Hard — needs architect |
| 7 | #848 | Class computed property / accessor correctness | **1,015 FAIL** | Medium — coordinates #799 |

### Phase 4: High-value ready items
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 8 | #852 | Destructuring params: null_deref + illegal_cast | **1,525 FAIL** | Hard |
| 9 | #766 | Symbol.iterator protocol for custom iterables | **~500 FAIL** | Medium |
| 10 | #851 | Iterator close protocol (async-gen remaining) | **~100 FAIL** | Medium |
| 11 | #763 | RegExp runtime method gaps | **~400 FAIL** | Medium |

### Phase 5: Refactoring (moved from sprint 36 — depends on #944 regression fix)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 12 | #910 | Split expressions.ts into syntax-family modules | High — largest file | Hard |
| 13 | #911 | Split statements.ts into control-flow, vars, destructuring, loops, functions | High | Hard |
| 14 | #912 | Remove circular dependencies from core codegen backend | High — contributor friction | Medium |
| 15 | #913 | Split compiler.ts into validation, orchestration, output | Medium | Medium |

## Dev paths

**Path 1 (Architect → Dev)**: #797 property descriptors — architect spec first, then 2-3 devs implementing subsystem
**Path 2 (Architect → Dev)**: #799 prototype chain — architect spec, then dev implementation  
**Path 3 (Dev)**: #943 + #923 + #934 — infrastructure fixes, independent of architectural work
**Path 4 (Dev)**: #852 + #766 — high-value ready items, can run in parallel

## Expected impact

| Area | Est. tests fixed |
|------|-----------------|
| #797 property descriptors | ~3,000-5,000 |
| #799 prototype chain | ~1,500-2,500 |
| #852 destructuring | ~800-1,200 |
| #766 Symbol.iterator | ~300-500 |
| Infrastructure (#943, #923, #934) | reliability + perf |
| **Total potential** | **~5,600-9,200** |

If achieved, this would push conformance from ~41% to ~55-60% — a transformative jump.

## Prerequisites

- #797 and #799 both need **architect specs** before dev work
- #943 (runner stability) should be fixed early so test262 validation is reliable
- Sprint 36 refactoring (#910-#913) would make #797/#799 implementation cleaner but is not blocking

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
