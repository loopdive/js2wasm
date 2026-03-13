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
- Issues organized by state: `plan/issues/ready/`, `blocked/`, `done/`, `backlog/`, `wont-fix/`
- Backlog at `plan/issues/backlog/backlog.md`, dependency graph at `plan/dependency-graph.md`
- Agent definitions in `.claude/agents/`
- Team spec at `plan/team.md`

## Developer Constraints
- **Up to 12 developers at a time.** Each runs in an isolated git worktree. Cherry-pick commits to main as they complete.
- **Same-file is OK if different functions.** Most codegen issues touch `expressions.ts` but modify different functions. Git 3-way merge handles this cleanly. Only avoid parallel work on the *same function*.
- **Cherry-pick, don't merge.** Each worktree is based on an older main. Cherry-pick individual commits to avoid pulling in stale state. Resolve `plan/` conflicts (log.md, dependency-graph.md) by keeping both sides.
- **Batch diagnostic-only issues directly.** Issues that only add a code to `DOWNGRADE_DIAG_CODES` don't need a developer agent — do them in one commit.

## Conflict Avoidance Strategy
1. **Separate test files per issue.** Each developer writes tests to `tests/issue-{N}.test.ts` or `tests/equivalence/{topic}.test.ts`. Never append to a shared file.
2. **Batch diagnostic-only issues directly.** Issues that just add a code to `DOWNGRADE_DIAG_CODES` in `src/compiler.ts` don't need a developer agent — do them in one commit.
3. **Developers update plan/ but conflicts are expected.** Plan file conflicts (log.md, dependency-graph.md) are trivial — keep both sides with `sed -i '/^<<<<<<</d; /^=======/d; /^>>>>>>>/d'`.
4. **Pick issues targeting different functions.** Multiple agents can touch `expressions.ts` simultaneously if they modify different functions (e.g., one does `compileBinaryExpression`, another does `compileInstanceOf`). Avoid two agents modifying the same function.
5. **Cherry-pick individual commits.** Never merge worktree branches — cherry-pick the single fix commit. This avoids pulling in stale base state. Use `git cherry-pick --no-commit` + inspect, or `git cherry-pick` directly if clean.
6. **Already-done issues are common.** Many issues turn out to be already fixed by prior work. Agents should verify the issue is still open before implementing. Close these with just a plan file update.

## Issue Frontmatter

Every open issue has YAML frontmatter:

```yaml
---
priority: high
depends_on: [234]
files:
  src/codegen/expressions.ts:
    new:
      - "compileMethodCallOnLiteral() — handles method calls on object literals"
    breaking:
      - "compileCallExpression: new `calleeType` param added to signature"
      - "coerceType: null handling changed — returns i32.const 0 instead of ref.null"
  src/codegen/index.ts:
    new:
      - "collectMethodCalls() — scans for method call patterns"
    breaking: []
---
```

Fields:
- **priority**: `critical` | `high` | `medium` | `low`
- **depends_on**: issue numbers that must be done first
- **files**: map of source files this issue needs to modify. File locking — no two in-progress issues may claim the same file without PO approval. Each file entry has:
  - **new**: new functions, types, exports being added
  - **breaking**: changes to existing functionality that other code depends on:
    - Changed function signatures (new/removed/reordered params)
    - Changed return types or semantics
    - Renamed or removed exported functions/types
    - Changed data structures (struct field order, type changes)
    - Modified control flow that callers rely on (e.g., a function that used to return now throws)

Both `new` and `breaking` must be documented **before** implementation starts so the PO can check whether any other in-progress or ready issues depend on the affected code. After implementation, preserve them in the issue's Implementation Summary for future reference.

## Execution Workflow (dependency-driven)

Work is driven by the dependency graph, not sprint batches.

1. **Pick work**: choose any issue from `plan/issues/ready/` — check `plan/dependency-graph.md` for contention
2. **Batch diagnostics**: issues that only add a code to `DOWNGRADE_DIAG_CODES` don't need a developer agent
3. **Launch developers**: max 2 in parallel, on non-conflicting files (check dependency graph "File contention" table)
4. **After each completion**: merge branch, then follow issue completion procedure:
   - Move `ready/{N}.md` → `done/{N}.md`
   - Add `completed: YYYY-MM-DD` frontmatter
   - Append `## Implementation Summary` (what was done, what worked, what didn't, files changed, tests now passing)
   - Add entry to `plan/issues/done/log.md`
   - Check `plan/issues/blocked/` — move newly unblocked issues to `ready/`
   - Update `plan/dependency-graph.md`
5. **Run tests**: `npx tsx scripts/run-test262.ts` (standalone runner, lighter than vitest on memory)

## Merge Lessons
- Vitest test262 run is memory-heavy (~1.5GB+), gets OOM killed if run alongside agents
- Use standalone runner `scripts/run-test262.ts` instead — processes categories sequentially
- After merging many branches touching equivalence.test.ts, reconstruct by extracting new tests from each branch parent (via `git show {parent}:tests/equivalence.test.ts`) and appending to base
- Always verify with TS parser (`ts.createSourceFile`) before committing reconstructed test files
