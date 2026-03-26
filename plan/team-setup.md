---
name: Team Setup
description: Agent team configuration — PO, Developer, Tester roles with worktree isolation and sprint workflow
type: project
---

# Team Setup

## Overview

All agents run as **teammates** in a single team (not subagents). This enables direct messaging between developers, tester, and PO for coordination — especially file conflict avoidance and test requests.

## Memory Budget (24GB Mac host)

- **Container**: `--memory=18g --memory-swap=34g` (18GB RAM + 16GB swap)
- **NODE_OPTIONS**: `--max-old-space-size=3072`
- **Test262**: default 3 workers (~9GB total), up to 5 solo (`TEST262_WORKERS=5`)
- **Dev agents**: ~2.5GB each
- **Max agents**: 4 devs without test262, 3 devs with test262 running
- **Stop dispatching** above 90% context/token usage — focus on cherry-picks only
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

### Tester (teammate)
Sonnet model. Runs test suites, evaluates results, creates issues in `plan/`. Serializes test runs — only ONE test suite at a time.

## Team Spawn

Use `TeamCreate` to create the team, then spawn all roles as teammates:

```
TeamCreate: "ts2wasm"
  - product-owner (agent def: .claude/agents/product-owner.md)
  - tester (agent def: .claude/agents/tester.md)
  - developer × N (agent def: .claude/agents/developer.md, isolation: worktree)
```

All teammates can `SendMessage` to each other by name. Devs broadcast file claims, request tests from tester, and report completion to tech lead.

## Communication Protocol

### Developer → all devs (broadcast)
When starting work:
1. Check `plan/file-locks.md` for conflicts
2. Add claim to the lock table
3. Broadcast: `"Claiming compileCallExpression in expressions.ts for #512"`

When discovering a dependency: `"My fix for #512 requires coerceType change — anyone in type-coercion.ts?"`
On completion: remove claim from `plan/file-locks.md`

### Developer → tester
When ready for testing: `"Worktree at /tmp/..., run equivalence tests for issue #512"`

### Tester → developer
Test results: `"2 failures in issue-512.test.ts: [details]"` or `"All green, ready for cherry-pick"`

### Tester → tech lead
After validation: `"Dev-A clean, cherry-pick ready"` or `"Test262 run complete: 16,500 pass / 1,400 CE"`

### Developer → tech lead
When done: `"Issue #512 complete, worktree branch: issue-512-call-expressions, commit: abc1234"`

## Worktree Isolation (MANDATORY)

- **ALL agents that write files MUST use `isolation: "worktree"`.** Only read-only agents (Explore, Plan) may skip it.
- **No agent edits main directly.** Cherry-pick completed work from worktree branches.
- **Tech lead works only at `/workspace` on `main`.** Always verify with `cd /workspace && git branch --show-current` before git ops. Never `cd` into agent worktrees — use `git -C <path>` to inspect.

## Developer Constraints

- **Max 4 devs (3 with test262 running).** Each in an isolated git worktree.
- **Same-file is OK if different functions.** Git 3-way merge handles separate hunks. Avoid parallel work on the *same function*.
- **Cherry-pick, don't merge.** Each worktree is based on an older main. Cherry-pick individual commits to avoid stale state.
- **Batch diagnostic-only issues.** Issues that only add a code to `DOWNGRADE_DIAG_CODES` don't need a developer — do them in one commit.
- **Each dev writes tests to `tests/issue-{N}.test.ts`.** Never append to `equivalence.test.ts` (top conflict source).
- **Devs do NOT run test262 or full vitest.** Message tester when ready. Single test files are OK.
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
