# Sprint 31 (Redo)

**Date**: 2026-03-30
**Goal**: Re-apply sprint-31 fixes without regressions. Test262 between EVERY merge.
**Baseline**: 18,599 pass / 48,088 total (38.7%)

## Learnings from Sprint 31

### What went wrong
1. **4 merges stacked without test262 between them** → regressions compounded undetected
2. **#862 try/catch_all** caught SyntaxErrors → 880 regressions. DO NOT wrap generators in try/catch_all.
3. **#826 guarded casts** with throw fallback → 1,300 null deref. ref.null fallback is better but still net negative when combined with stack-balance.ts changes.
4. **Each change was individually net positive** but their interaction was net negative. Cannot predict interaction from isolated tests.
5. **Equiv tests don't catch these regressions** — only full test262 does.

### Rules for this sprint
1. **ONE merge at a time**. After each merge, run FULL test262 (not just equiv).
2. **Compare pass count after each merge**. If it goes down: revert immediately, document in issue.
3. **Safe issues first** — start with changes that can't regress (#839, #866, #854). Save risky ones (#822 B, #826, #862) for last.
4. **No stacking**. Wait for test262 results before merging the next branch.

## Task queue (ordered by risk — safe first)

| Order | Issue | Risk | Impact | Notes |
|-------|-------|------|--------|-------|
| 1 | #839 | Low | 40 CE | Tail call guard — isolated to statements.ts |
| 2 | #866 | Low | 71 FAIL | sNaN sentinel — isolated changes |
| 3 | #854 | Low | 32 FAIL | WasmGC iterable — runtime.ts only |
| 4 | #822 A | Low | ~139 CE | Backward walk — architect-verified safe |
| 5 | #822 C | Low | ~20 CE | local.set look — small change |
| 6 | #851 | Medium | 0 direct | Iterator infra — no test flips but adds new export |
| 7 | #822 B | Medium | ~143 CE | ref↔ref coercion — was net +900 but adds ref.cast_null |
| 8 | #828 | Low | 149 CE | Already fixed by prior work — smoke-test to confirm |
| 9 | #826 | HIGH | 255 FAIL | Guarded casts — caused 1,300 regressions in sprint-31 |
| 10 | #862 | HIGH | 212 FAIL | Generator throw — caused 880 regressions in sprint-31 |
| 11 | #876 | None | Dashboard | Non-compiler, safe |
| 12 | #877 | None | Agile defs | Non-compiler, safe |
| 13 | #868 | None | Playground | Non-compiler, safe |

## Merge protocol (strict for this sprint)

For EACH issue:
1. Dev implements in worktree
2. Dev merges main into branch: `git merge main`
3. Dev runs full test262 ON THE BRANCH: `pnpm run test:262`
4. Dev records pass count. Must be >= previous pass count on main.
5. Dev creates merge proof with test262 pass count
6. Dev merges to main: `git merge --ff-only`
7. Run test262 on main to confirm (optional but recommended for risky changes)
8. If pass count dropped: revert immediately, document in issue

## Results

(Fill after each merge)

| Order | Issue | Pre-merge pass | Post-merge pass | Delta | Status |
|-------|-------|---------------|----------------|-------|--------|
| 1 | #839 | 18,599 | | | |
| 2 | #866 | | | | |
| 3 | #854 | | | | |
| 4 | #822 A | | | | |
| 5 | #822 C | | | | |
| 6 | #851 | | | | |
| 7 | #822 B | | | | |
| 8 | #828 | | | | |
| 9 | #826 | | | | |
| 10 | #862 | | | | |
| 11 | #876 | | | | |
| 12 | #877 | | | | |
| 13 | #868 | | | | |
