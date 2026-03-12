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

## Sprint Workflow
1. PO analyzes test262 results and plans sprint (creates issues, sprint plan, updates backlog)
2. Developers spawned in parallel with worktree isolation (grouped to minimize merge conflicts)
3. All branches merged into main (plan/ conflicts: theirs for issues, ours for backlog; test conflicts: keep both sides)
4. Test file reconstruction may be needed after merges (sed to remove conflict markers can mangle interleaved test blocks)
5. Run test262 standalone runner (`npx tsx scripts/run-test262.ts`) — lighter than vitest on memory

## Merge Lessons
- Vitest test262 run is memory-heavy (~1.5GB+), gets OOM killed if run alongside agents
- Use standalone runner `scripts/run-test262.ts` instead — processes categories sequentially
- After merging many branches touching equivalence.test.ts, reconstruct by extracting new tests from each branch parent (via `git show {parent}:tests/equivalence.test.ts`) and appending to base
- Always verify with TS parser (`ts.createSourceFile`) before committing reconstructed test files
