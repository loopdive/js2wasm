# Sprint 36 — Contributor Readiness & Code Quality

**Date**: 2026-04-03
**Goal**: Make the codebase welcoming to new contributors and reduce technical debt from rapid feature sprints
**Baseline**: 17,717 pass / 43,120 official (41.1%) — post sprint 35

## Context

After 5 sprints of compiler work (31–35), the codebase has accumulated:
- `src/codegen/index.ts` still at ~14.5K lines despite #909 extracting context/registry
- `expressions.ts` and `statements.ts` are monolithic (~16K and ~3K lines)
- No CONTRIBUTING.md, no architecture docs, no starter issues
- Lint/format not enforced consistently
- Several regressions from rapid merges need targeted fixes

Sprint 36 focuses entirely on contributor readiness and code quality — no new features.

## Task queue

### Phase 1: Refactoring (from #909 sub-issues)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 1 | #910 | Split expressions.ts into syntax-family modules | High — largest file | Hard |
| 2 | #911 | Split statements.ts into control-flow, vars, destructuring, loops, functions | High | Hard |
| 3 | #912 | Remove circular dependencies from core codegen backend | High — contributor friction | Medium |
| 4 | #913 | Split compiler.ts into validation, orchestration, output | Medium | Medium |

### Phase 2b: Dev infrastructure
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 4b | #924 | Vite dev server OOMs / consumes 9GB+ loading playground | **High** — blocks local dev | Medium |

### Phase 3: Contributor experience
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 5 | #914 | Compiler architecture overview for contributors | High — first thing new devs read | Easy |
| 6 | #915 | CONTRIBUTING.md with minimum safe contributor workflow | High — funding requirement | Easy |
| 7 | #916 | Clean contributor-facing repo hygiene, remove clutter | Medium | Easy |
| 8 | #917 | Lint, format, typecheck consistently across source tree | Medium | Medium |
| 9 | #918 | Curated batch of contributor-friendly starter issues | High — onboarding | Easy |

### Phase 4: Compiler correctness
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 10 | #923 | Fix compiler state leakage between compile() calls | **Critical** — blocks LSP/watch/REPL | Hard |
| 11 | #919 | Fix direct-eval arguments regressions since April 1 baseline | Medium | Medium |
| 12 | #920 | Recover RegExp feature acceptance regressions | Medium | Medium |
| 13 | #921 | Fix class destructuring generator/private-method Wasm type mismatches | Medium | Medium |
| 14 | #922 | Add reproducible test262 baseline-diff workflow | High — prevents future regressions | Medium |

### Phase 5: Error reporting quality (from 2026-04-03 error analysis)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 15 | #931 | Error location reporting: 83% of CE errors lack line numbers | **High** — DX quality | Medium |
| 16 | #927 | Missing early/parse error detection (840 FAIL) | **High** — correctness + conformance | Hard |
| 17 | #932 | Landing page: replace perf score with JS feature coverage % | Medium — clarity | Easy |
| 18 | #933 | Migrate report.html charts to shared t262-charts.js web components | Medium — DRY | Medium |
| 19 | #942 | JS feature compatibility report ranked by real-world importance | **High** — user/contributor clarity | Medium |

## Dev paths

**Dev-1**: #910 → #911 → #912 → #913 (refactoring — sequential, each depends on prior)
**Dev-2**: #914 → #915 → #916 → #917 → #918 (contributor docs — can run in parallel with dev-1)
**Dev-3**: #919 → #920 → #921 → #922 (regression fixes — independent of refactoring)

## Notes

- Phase 2 (refactoring) is the riskiest — each extraction must preserve all tests
- Phase 3 (contributor docs) is safe and can merge independently
- Phase 4 (regressions) should ideally run after phase 2 to avoid conflicts
- #922 (baseline-diff workflow) should be prioritized early if possible — it protects all other work

## Results

(Fill after sprint completion)

## Retrospective

(To be filled after sprint completion)
