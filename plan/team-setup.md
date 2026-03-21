---
name: Team Setup
description: Agent team configuration — PO, Developer, Tester roles with worktree isolation and sprint workflow
type: project
---

## Team Roles
- **Project Lead** (human): Owns the architecture and vision. Thinks in compilation strategies — frames problems as "what compilation approach makes this work?" not "does the target support this?" Challenges assumptions aggressively: every feature labeled "impossible" (eval, Proxy, with) got a viable implementation path after pushback. Key design decisions (Proxy trap inlining, eval via host compilation, tagged struct variants for Symbol keys) come from the project lead. Delegates implementation to agents but steers the design.
- **Tech Lead**: opus model, manages the main working copy. **Owns everything outside `plan/`**: `src/`, `tests/`, `scripts/`, `benchmarks/`, `.devcontainer/`, config files. Dispatches and monitors developer agents, cherry-picks completed work to main, resolves merge conflicts, runs tests. Does NOT write to `plan/issues/`, `plan/progress/`, or `plan/dependency-graph.md` — that's PO territory. May read `plan/` to pick work and check priorities. Moves issue files between `ready/` → `done/` as part of the completion workflow (this is the one `plan/` write the Tech Lead does).
- **Product Owner**: opus model. **Only touches `plan/` directory.** Creates/updates issues, writes progress reports, manages backlog, analyzes test results, regenerates graph. Does NOT edit `src/`, `tests/`, `scripts/`, or any other code — that's the Tech Lead's domain. Reads results and code for analysis but never writes outside `plan/`.
- **Developer**: opus model, worktree isolation, implements fixes in src/ and tests/
- **Tester**: sonnet model, runs test262 suite, monitors for hangs, analyzes results, creates/updates issues. Responsibilities:
  - **Always run test262 in a worktree** — never on main working copy. Use `scripts/run-test262-vitest.sh` or `git worktree add /tmp/ts2wasm-test262 HEAD`. This prevents stash conflicts when cherry-picking agent work to main.
  - Run via vitest with compiler pool: `TEST262_WORKERS=4 npx vitest run tests/test262-vitest.test.ts --pool=threads --poolOptions.threads.maxThreads=1`
  - Monitor `benchmarks/results/test262-current.txt` for hanging tests
  - When a test hangs: kill the runner, add a skip filter to `tests/test262-runner.ts` with comment referencing the issue, create/update an issue in `plan/issues/ready/`, resume with `--resume`
  - After run completes: analyze error patterns, update issue metrics (test262_ce, test262_fail, test262_skip), create new issues for unmatched patterns
  - Every skip filter MUST have a corresponding issue — skips are workarounds, not fixes
  - Update `benchmarks/results/conformance-history.json` (auto-appended by runner)
  - Regenerate graph: `npx tsx plan/generate-graph.ts`

## Conventions
- Branch naming: `issue-{N}-{short-description}`
- Issues organized by state: `plan/issues/ready/`, `blocked/`, `done/`, `backlog/`, `wont-fix/`
- Backlog at `plan/issues/backlog/backlog.md`, dependency graph at `plan/dependency-graph.md`
- Agent definitions in `.claude/agents/`
- Team spec at `plan/team.md`

## Worktree Isolation (MANDATORY)
- **ALL agents that write files MUST use `isolation: "worktree"`.** The main working copy is controlled by a separate agent. Only read-only agents (Explore, Plan) may skip worktree isolation.
- **No agent may edit files on main directly.** Cherry-pick completed work from worktree branches to main after review.

## Developer Constraints
- **Up to 4 developers at a time.** Each runs in an isolated git worktree. Cherry-pick commits to main as they complete.
- **Same-file is OK if different functions.** Most codegen issues touch `expressions.ts` but modify different functions. Git 3-way merge handles this cleanly. Only avoid parallel work on the *same function*.
- **Cherry-pick, don't merge.** Each worktree is based on an older main. Cherry-pick individual commits to avoid pulling in stale state. Resolve `plan/` conflicts (log.md, dependency-graph.md) by keeping both sides.
- **Batch diagnostic-only issues directly.** Issues that only add a code to `DOWNGRADE_DIAG_CODES` don't need a developer agent — do them in one commit.
- **Stop dispatching above 90% usage.** Do not launch new developer agents when context/token usage is above 90%. Focus on cherry-picking completed work and wrapping up.

## Conflict Avoidance Strategy
1. **Separate test files per issue.** Each developer writes tests to `tests/issue-{N}.test.ts` or `tests/equivalence/{topic}.test.ts`. Never append to a shared file.
2. **Batch diagnostic-only issues directly.** Issues that just add a code to `DOWNGRADE_DIAG_CODES` in `src/compiler.ts` don't need a developer agent — do them in one commit.
3. **Developers update plan/ but conflicts are expected.** Plan file conflicts (log.md, dependency-graph.md) are trivial — keep both sides with `sed -i '/^<<<<<<</d; /^=======/d; /^>>>>>>>/d'`.
4. **Pick issues targeting different functions.** Multiple agents can touch `expressions.ts` simultaneously if they modify different functions (e.g., one does `compileBinaryExpression`, another does `compileInstanceOf`). Avoid two agents modifying the same function.
5. **Cherry-pick individual commits.** Never merge worktree branches — cherry-pick the single fix commit. This avoids pulling in stale base state. Use `git cherry-pick --no-commit` + inspect, or `git cherry-pick` directly if clean.
6. **Already-done issues are common.** Many issues turn out to be already fixed by prior work. Agents should verify the issue is still open before implementing. Close these with just a plan file update.
7. **Document agent findings.** When an agent completes (success or failure), always document its root cause analysis, implementation plan, and findings in the issue file before moving it to done/ or backlog/. This preserves knowledge for future attempts.

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

## Execution Workflow (continuous, dependency-driven)

Work is driven by the dependency graph, not sprint batches. Maintain a **rolling pool of 4 developer agents** — whenever one finishes, cherry-pick its work to main and immediately launch a new agent on the next ready issue.

1. **Pick work**: choose any issue from `plan/issues/ready/` — check `plan/dependency-graph.md` for contention
2. **Batch diagnostics**: issues that only add a code to `DOWNGRADE_DIAG_CODES` don't need a developer agent
3. **Launch developers**: max 4 in parallel, on non-conflicting functions (check dependency graph "File contention" table)
4. **After each completion**: cherry-pick commit to main, then follow issue completion procedure:
   - Move `ready/{N}.md` → `done/{N}.md`
   - Add `completed: YYYY-MM-DD` frontmatter
   - Append `## Implementation Summary` (what was done, what worked, what didn't, files changed, tests now passing)
   - Add entry to `plan/issues/done/log.md`
   - Check `plan/issues/blocked/` — move newly unblocked issues to `ready/`
5. **Immediately launch replacement**: pick the next ready issue that doesn't conflict with running agents and launch a new developer agent — keep 4 slots filled at all times until no ready issues remain
   - Update `plan/dependency-graph.md`
5. **Run tests**: `npx tsx scripts/run-test262.ts` (standalone runner, lighter than vitest on memory)

## Merge Lessons
- Vitest test262 run is memory-heavy (~1.5GB+), gets OOM killed if run alongside agents
- Use standalone runner `scripts/run-test262.ts` instead — processes categories sequentially
- After merging many branches touching equivalence.test.ts, reconstruct by extracting new tests from each branch parent (via `git show {parent}:tests/equivalence.test.ts`) and appending to base
- Always verify with TS parser (`ts.createSourceFile`) before committing reconstructed test files
