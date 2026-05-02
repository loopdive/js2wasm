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

**Baseline (start)**: 15,526 pass (36.2%) — real, cache-disabled
**Baseline (end)**: 17,822 pass / 43,120 total (41.3%) — confirmed real, cache disabled, proposals pre-filtered
**Delta**: +2,296 pass (+6.1pp)

**Completed issues (14)**: #914, #915, #916, #917, #918, #919, #920, #921, #922, #927, #932, #933, #942, #944
**Rejected**: #931 (fatal crash in error reporting migration — only 1,879/48K tests ran)
**Deferred to sprint 37**: #923 (state leakage), #931 (needs fix), #910-#913 (refactoring)

## Retrospective

### Completed (14 issues)
- #914: Architecture overview (docs/ARCHITECTURE.md)
- #915: CONTRIBUTING.md
- #916: Repo hygiene (-1,236 lines of clutter)
- #917: Lint/format/typecheck consistency + CI workflow
- #918: 7 contributor-friendly starter issues (#935-#941)
- #919: Eval/args async closure fix (Promise.resolve wrapping)
- #920: RegExp regressions (extern class method fallthrough)
- #921: Class dstr type mismatch (pushBody/popBody fix)
- #922: Baseline-diff script (scripts/diff-test262.ts)
- #927: Early error detection (877 lines, 15 new ES error categories)
- #932: Feature coverage % + benchmark chart on landing page
- #933: Shared chart web components (t262-donut, t262-trend-chart)
- #942: Feature compatibility report (52 features ranked)
- #944: Regression fix — revert #855, fix #831 LHS validation

### Rejected
- #931: Error line numbers — migrated 132 ctx.errors.push calls but introduced fatal crash (only 1,879/48K tests ran). Needs debugging before retry.

### Deferred to sprint 37
- #923: Compiler state leakage (hard, needs focused attention)
- #931: Error line numbers (rejected, needs fix)
- #910-#913: Refactoring (sequential, high-risk)

### Baseline
- Session start: 15,526 pass (36.2%)
- After cache disabled + all merges: 17,822 pass (41.3%)
- Delta: **+2,296 pass (+5.1pp)**
- Note: 17,782 mid-session result was cache-inflated. 17,822 is the honest result with cache disabled.

## Retrospective

### What went well
- **14 issues completed** — highest throughput sprint. Contributor docs, CI, tooling, error detection, regression fix all landed.
- **Bisect tool saved the sprint** — scripts/diff-test262.ts identified #855 and #831 as regression culprits within minutes
- **test-and-merge.sh replaces tester agents** — zero token cost for merge validation. Saved ~5 agent spawns.
- **PO error analysis** produced 6 data-driven issues (#926-#931, #945) with clear root causes
- **Cache disabled** — discovered that the disk cache was causing false baselines. All results now honest.
- **#927 early error detection** — 877 lines of new ES spec validation, 15 error categories
- **Process improvements shipped** — senior-developer.md, reasoning_effort in issues, model selection rules

### What went wrong
- **#855 caused 1,451 regressions** — merged without proper test262 validation (equiv-only at first, then tester didn't build from branch)
- **Dismissed regression as "runner instability"** for hours — wasted 4+ test262 runs and significant time before bisecting
- **17,782 baseline was fake** — cache-inflated result accepted as real for hours. Led to incorrect regression analysis.
- **#931 crashed the compiler** — 132 error-push migrations introduced a fatal bug. test-and-merge.sh correctly caught it (only 1,879/48K tests ran).
- **30+ opus agents spawned** — burned 25% of weekly token budget. Most dev tasks don't need opus.
- **Tester agents couldn't build from worktrees** — repeatedly tested regressed code. Replaced by bash script.
- **Multiple test262 runs competing** — orphaned processes held locks, caused OOM

### Process improvements applied this sprint
1. **test-and-merge.sh** — bash script replaces tester agents (zero tokens per merge)
2. **Developer model: sonnet** — opus only for hard issues via senior-developer.md
3. **reasoning_effort in issues** — drives model selection (max→opus, high→sonnet, medium→haiku)
4. **Cache permanently disabled** — every test compiled fresh, no stale results
5. **Proposals pre-filtered** — staging/ tests excluded at file level, not just skip-tagged
6. **Never dismiss regressions** — always bisect with diff-test262.ts first
7. **Merge proof in worktree** — hook checks both locations
8. **CI workflow added** — lint + format + typecheck on PRs (#917)

### Lessons for sprint 37
1. Run test262 from branch source, not main — verify the bundle was actually rebuilt
2. Don't merge error-reporting refactors without thorough testing — they touch every codegen path
3. Keep max 3 devs + test262 — more causes OOM and lock contention
4. Use test-and-merge.sh instead of tester agents for all merges
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

---
_Issues not completed in this sprint were returned to the backlog._

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #914 | Add a short compiler architecture overview for contributors | high | done |
| #915 | Add CONTRIBUTING.md with the minimum safe contributor workflow | high | done |
| #916 | Clean contributor-facing repo hygiene and remove misleading clutter | high | done |
| #917 | Make lint, format, and typecheck apply consistently across the whole source tree | medium | done |
| #918 | Create a curated batch of contributor-friendly starter issues with exact file ownership and acceptance criteria | medium | done |
| #920 | Recover RegExp feature acceptance regressions relative to the April 1 test262 baseline | high | done |
| #922 | Add a reproducible test262 baseline-diff workflow so regressions are compared against current clean HEAD | medium | done |
| #932 | Landing page: replace performance score with JS feature coverage percentage | medium | done |
| #935 | Add String.fromCodePoint() static method | low | done |
| #942 | Generate JavaScript feature compatibility report ranked by real-world importance | high | done |

<!-- GENERATED_ISSUE_TABLES_END -->
