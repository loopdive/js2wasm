# Sprint 36 — Contributor Readiness & Code Quality

**Date**: TBD (after sprint 34 completes)
**Goal**: Make the codebase welcoming to new contributors and reduce technical debt from rapid feature sprints
**Baseline**: TBD (sprint 34 result)

## Context

After 5 sprints of compiler work (31–35), the codebase has accumulated:
- `src/codegen/index.ts` still at ~14.5K lines despite #909 extracting context/registry
- `expressions.ts` and `statements.ts` are monolithic (~16K and ~3K lines)
- No CONTRIBUTING.md, no architecture docs, no starter issues
- Lint/format not enforced consistently
- Several regressions from rapid merges need targeted fixes

Sprint 36 focuses entirely on contributor readiness and code quality — no new features.

## Task 0: Renumber sprints 32–35

The sprints were executed out of order this session. Renumber to match actual execution order:
- sprint-35.md (CE reduction, done first) → sprint-32
- sprint-32.md (STF presentability, done second) → sprint-33
- sprint-33.md (benchmark recovery, done third) → sprint-34
- sprint-34.md (push past 40%, planned fourth) → sprint-35

**Status**: Pending (first task in this sprint)

## Task queue

### Phase 1: Sprint renumbering (task 0)
| Order | Task | Status |
|-------|------|--------|
| 0 | Renumber sprint files 32↔35 to match execution order | pending |

### Phase 2: Refactoring (from #909 sub-issues)
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 1 | #910 | Split expressions.ts into syntax-family modules | High — largest file | Hard |
| 2 | #911 | Split statements.ts into control-flow, vars, destructuring, loops, functions | High | Hard |
| 3 | #912 | Remove circular dependencies from core codegen backend | High — contributor friction | Medium |
| 4 | #913 | Split compiler.ts into validation, orchestration, output | Medium | Medium |

### Phase 3: Contributor experience
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 5 | #914 | Compiler architecture overview for contributors | High — first thing new devs read | Easy |
| 6 | #915 | CONTRIBUTING.md with minimum safe contributor workflow | High — funding requirement | Easy |
| 7 | #916 | Clean contributor-facing repo hygiene, remove clutter | Medium | Easy |
| 8 | #917 | Lint, format, typecheck consistently across source tree | Medium | Medium |
| 9 | #918 | Curated batch of contributor-friendly starter issues | High — onboarding | Easy |

### Phase 4: Regression fixes
| Order | Issue | Title | Impact | Effort |
|-------|-------|-------|--------|--------|
| 10 | #919 | Fix direct-eval arguments regressions since April 1 baseline | Medium | Medium |
| 11 | #920 | Recover RegExp feature acceptance regressions | Medium | Medium |
| 12 | #921 | Fix class destructuring generator/private-method Wasm type mismatches | Medium | Medium |
| 13 | #922 | Add reproducible test262 baseline-diff workflow | High — prevents future regressions | Medium |

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
