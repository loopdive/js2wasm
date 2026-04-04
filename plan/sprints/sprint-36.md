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

### Phase 1: Contributor experience
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

### ~~Phase 6: Refactoring~~ — moved to sprint 37 (depends on #944 regression fix)
~~#910, #911, #912, #913~~ — see sprint-37.md

### Done (completed earlier)
- ~~#924~~ — Vite dev server OOM (done in sprint 35)

## Dev paths

Parallel tracks, refactoring last:
**Dev-3**: #919 → #920 → #921 → #922 (regression fixes — independent of refactoring)

## Notes

- Phase 2 (refactoring) is the riskiest — each extraction must preserve all tests
- Phase 3 (contributor docs) is safe and can merge independently
- Phase 4 (regressions) should ideally run after phase 2 to avoid conflicts
- #922 (baseline-diff workflow) should be prioritized early if possible — it protects all other work

## Results

(Fill after sprint completion)

## Retrospective

### Completed
- #914: Architecture overview (docs/ARCHITECTURE.md)
- #915: CONTRIBUTING.md
- #916: Repo hygiene (-1,236 lines of clutter)
- #917: Lint/format/typecheck consistency + CI workflow
- #918: 7 contributor-friendly starter issues (#935-#941)
- #922: Baseline-diff script (scripts/diff-test262.ts)
- #932: Feature coverage % + benchmark chart on landing page
- #942: Feature compatibility report (52 features ranked)
- #944: Regression fix — revert #855, fix #831 LHS validation

### In progress / pending merge
- #920: RegExp regressions (test-and-merge running)
- #921: Class dstr type mismatch (branch ready)
- #919: Eval/args async closure fix (branch ready)
- #927: Early error detection — 5 commits (branch ready)
- #931: Error line numbers — 132 calls migrated (branch ready)

### Deferred to sprint 37
- #923: Compiler state leakage (hard, needs focused attention)
- #933: Shared chart web components
- #910-#913: Refactoring (sequential, high-risk)

### Honest baseline
- Pre-session: 15,526 pass (36.2%)
- Current (post #944 fix): 16,268 pass (37.7%)
- Improvement: +742 pass
- Note: The 17,782 result was cache-inflated and never real

## Retrospective (draft — finalize after all merges)

### What went well
- **Bisect tool saved the sprint** — scripts/diff-test262.ts identified #855 and #831 as regression culprits within minutes
- **test-and-merge.sh replaces tester agents** — zero token cost for merge validation
- **PO error analysis** produced 6 data-driven issues with clear root causes
- **Contributor docs shipped** — ARCHITECTURE.md, CONTRIBUTING.md, starter issues, CI workflow
- **9 issues completed** despite regression disruption

### What went wrong
- **#855 caused 1,451 regressions** — merged without proper test262 validation (equiv-only)
- **Dismissed regression as "runner instability"** for hours — wasted 4+ test262 runs before bisecting
- **17,782 baseline was fake** — cache-inflated result accepted as real. Only discovered after reverting #855 showed same 16,268
- **Tester agents couldn't build from worktrees** — they built from main, testing regressed code repeatedly
- **30+ opus agents spawned** — burned 25% of weekly token budget in one day
- **Too many concurrent agents** — OOMed test262, crashed docker

### Process improvements applied
1. **test-and-merge.sh** — bash script replaces tester agents (zero tokens)
2. **Developer model selection** — sonnet default, opus for hard issues only
3. **senior-developer.md** — separate agent role for hard issues
4. **reasoning_effort in issues** — drives model selection
5. **Never dismiss regressions** — always bisect first (memory saved)
6. **Merge proof in worktree** — hook checks both locations
