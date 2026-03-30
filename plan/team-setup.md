---
name: Team Setup
description: Agent team configuration — PO, Developer, Tester roles with worktree isolation and sprint workflow
type: project
---

# Team Setup

## Overview

All agents run as **teammates** in a single team (not subagents). This enables direct messaging between developers, tester, and PO for coordination — especially file conflict avoidance and test requests.

## Memory Budget

- **Container**: `--memory=16g --memory-swap=32g` (16GB RAM + 16GB swap)
- **NODE_OPTIONS**: `--max-old-space-size=3072`
- **Test262**: default 2 workers during dev (~5.5GB). After dev batch completes, use 3 workers (`TEST262_WORKERS=3`) for faster measurement (~9GB, no devs running). Pool workers capped at 1GB each.
- **Dev agents**: ~2.5GB each
- **Max agents**: up to 8 devs when not running test262 (~500MB each). 0 devs during test262 run.
- **Stop dispatching** above 90% context/token usage — focus on merges only
- Always check `free -h` before launching agents

## Roles

### Project Lead (human)
Owns the architecture and vision. Thinks in compilation strategies. Challenges assumptions — every feature labeled "impossible" got a viable implementation path. Delegates implementation to agents but steers the design.

### Tech Lead (orchestrator)
Opus model, manages the main working copy. **Owns everything outside `plan/`**. Dispatches and monitors teammates, cherry-picks completed work to main, resolves merge conflicts. The one `plan/` write the Tech Lead does: move issue files `ready/` → `done/`.

### Product Owner (teammate)
Opus model. **Only touches `plan/` directory.** Creates/updates issues, manages backlog, analyzes test results. Does NOT edit `src/`, `tests/`, `scripts/`. Reads results and code for analysis only.

### Developer (teammate, worktree)
Opus model, worktree isolation. Implements fixes in `src/` and `tests/`. Communicates with other devs and tester via messages.

### Tester (NO dedicated teammate)
The **Tech Lead runs all tests directly** in background — no tester teammate. This prevents OOM from test262 workers + agent processes competing for memory. Test262 uses 3 workers (~9GB), so only 1 dev can run alongside it.

## Team Spawn

Use `TeamCreate` to create the team, then spawn roles:

```
TeamCreate: "ts2wasm"
  - developer × 2 max (agent def: .claude/agents/developer.md, isolation: worktree)
  - product-owner on demand (agent def: .claude/agents/product-owner.md)
  - NO tester — TTL runs tests directly
```

All teammates can `SendMessage` to each other by name. Devs broadcast file claims and report completion to tech lead. TTL runs tests after merges.

## Communication Protocol

### Developer → all devs (broadcast)
When starting work:
1. Check `plan/file-locks.md` for conflicts
2. Add claim to the lock table
3. Broadcast: `"Claiming compileCallExpression in expressions.ts for #512"`

When discovering a dependency: `"My fix for #512 requires coerceType change — anyone in type-coercion.ts?"`
On completion: remove claim from `plan/file-locks.md`

### Developer → tech lead
When done: `"Issue #512 complete, worktree branch: issue-512-call-expressions, commit: abc1234"`
TTL runs tests after merge — devs do NOT run full test262.

## Worktree Isolation (MANDATORY)

- **ALL agents that write files MUST use `isolation: "worktree"`.** Only read-only agents (Explore, Plan) may skip it.
- **No agent edits main directly.** TTL merges completed work from worktree branches.
- **Tech lead works only at `/workspace` on `main`.** Always verify with `cd /workspace && git branch --show-current` before git ops. Never `cd` into agent worktrees — use `git -C <path>` to inspect.

## Developer Constraints

- **Up to 8 devs when not running test262.** Each in an isolated git worktree (~500MB each). Shut down all devs before running test262.
- **Same-file is OK if different functions.** Git 3-way merge handles separate hunks. Avoid parallel work on the *same function*.
- **Merge to main (not cherry-pick).** TTL merges worktree branches.
- **Batch diagnostic-only issues.** Issues that only add a code to `DOWNGRADE_DIAG_CODES` don't need a developer — do them in one commit.
- **Each dev writes tests to `tests/issue-{N}.test.ts`.** Never append to `equivalence.test.ts` (top conflict source).
- **Devs validate by compiling AND running specific failing tests.** Do NOT run `npm test` or `vitest`.
  ```bash
  # 1. Compile a specific test262 file:
  timeout 8 npx tsx src/cli.ts test262/test/language/expressions/class/dstr/some-test.js
  # 2. Run the compiled wasm to verify it actually works:
  node -e "const fs=require('fs'); const w=fs.readFileSync('test262/test/language/expressions/class/dstr/some-test.js.wasm'); const i=require('./test262/test/language/expressions/class/dstr/some-test.js.imports.js'); WebAssembly.instantiate(w,i).then(m=>{const r=m.instance.exports.test?.();console.log('result:',r)})"
  # result: 1 means pass. Test 3-5 files before committing.
  ```
  When ready for full validation, message the TTL: "Ready for testing, please run tests".
  The TTL runs `npm test` and `pnpm run test:262` after merging — devs never run these.
- **Document findings.** Always write root cause analysis and implementation notes in the issue file before completion.

## Cherry-Pick Workflow

1. Wait for all agents in a wave to complete (or a dev signals "ready")
2. Tester validates the worktree
3. Tech lead cherry-picks: `cd /workspace && git cherry-pick <commit>`
4. Resolve plan/ conflicts: keep both sides
5. Launch replacement dev on next ready issue

## Issue Lifecycle

### Frontmatter format
```yaml
---
priority: high
depends_on: [234]
files:
  src/codegen/expressions.ts:
    new:
      - "compileMethodCallOnLiteral()"
    breaking:
      - "compileCallExpression: new calleeType param"
---
```

The `files` field is a **planned lock claim**. At runtime, active locks are tracked in `plan/file-locks.md`. Before starting, devs check the lock table. Overlap requires developer-to-developer coordination via messages or PO approval.

### Completion procedure
1. Move `ready/{N}.md` → `done/{N}.md`
2. Add `completed: YYYY-MM-DD` frontmatter
3. Append `## Implementation Summary` (what was done, what worked, what didn't, files changed, tests passing)
4. Add entry to `plan/issues/done/log.md`
5. Check `plan/issues/blocked/` — move newly unblocked issues to `ready/`
6. Update `plan/dependency-graph.md`

## Test262

- **Always run in a worktree** — never on main working copy
- Use `pnpm run test:262` (default 3 workers) or `scripts/run-test262-vitest.sh`
- **Only one test262 run at a time.** Check `ps aux | grep test262` first.
- Every skip filter MUST have a corresponding issue
- History tracked in `benchmarks/results/runs/index.json`
- Never delete run data from `benchmarks/results/runs/`

## Merge Lessons

- After merging many branches touching `equivalence.test.ts`, reconstruct by extracting new tests from each branch parent and appending to base
- Always verify with TS parser (`ts.createSourceFile`) before committing reconstructed test files
- Test262 with 3 workers uses ~9GB — 16GB swap absorbs spikes instead of OOM-killing
