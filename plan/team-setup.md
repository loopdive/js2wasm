---
name: Team Setup
description: Agent team configuration — PO, Developer, Tester roles with worktree isolation and sprint workflow
type: project
---

## Team Roles
- **Product Owner**: opus model, manages plan/ files, sprint planning and review
- **Developer**: opus model, worktree isolation, implements fixes in src/ and tests/
- **Tester**: sonnet model, runs tests, evaluates results, creates issues

## Conventions
- Branch naming: `issue-{N}-{short-description}`
- Issues in `plan/issues/{N}.md`, backlog at `plan/backlog.md`, sprint plans at `plan/sprint-{N}.md`
- Agent definitions in `.claude/agents/`
- Team spec at `plan/team.md`

## Developer Constraints
- **Max 2 developers at a time.** Do not launch large batches.
- **No file overlap.** Before launching a pair of developers, check which files each issue will modify. If they overlap, run them sequentially.
- **Merge before next.** After a developer finishes, merge their changes back to main before launching the next developer whose worktree should be based on the updated main.

## Conflict Avoidance Strategy
1. **Separate test files per issue.** Each developer writes tests to `tests/issue-{N}.test.ts` instead of appending to `equivalence.test.ts`. Consolidate later if desired.
2. **Batch diagnostic-only issues manually.** Issues that just add a code to `DOWNGRADE_DIAG_CODES` in `src/compiler.ts` don't need a developer agent — do them in one commit directly.
3. **Developers don't touch `plan/`.** Update `backlog.md` and `issues/*.md` after merging, not during development.
4. **Pair by source file.** Only run two developers in parallel if they touch different source files (e.g., one `expressions.ts`, one `statements.ts`). Two issues both needing `expressions.ts` must be sequential.

## Sprint Workflow
1. PO analyzes test262 results and plans sprint (creates issues, sprint plan, updates backlog)
2. Batch-commit all diagnostic-only issues (manual, fast — no developer agent needed)
3. Sort remaining codegen issues by which source file they modify
4. Developers spawned in pairs (max 2), with worktree isolation, ensuring no file overlap between the pair
5. After each pair completes, merge branches into main before starting the next pair
6. Update `plan/backlog.md` and issue files after merging (not by developers)
5. Run test262 standalone runner (`npx tsx scripts/run-test262.ts`) — lighter than vitest on memory

## Merge Lessons
- Vitest test262 run is memory-heavy (~1.5GB+), gets OOM killed if run alongside agents
- Use standalone runner `scripts/run-test262.ts` instead — processes categories sequentially
- After merging many branches touching equivalence.test.ts, reconstruct by extracting new tests from each branch parent (via `git show {parent}:tests/equivalence.test.ts`) and appending to base
- Always verify with TS parser (`ts.createSourceFile`) before committing reconstructed test files
