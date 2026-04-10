---
name: Team Setup
description: Agent team configuration — PO and Developer roles with worktree isolation and PR-based CI workflow
type: project
---

# Team Setup

## Overview

All agents run as **teammates** in a single team (not subagents). This enables direct messaging between developers and PO for coordination — especially file conflict avoidance and sprint handoff.

## Memory Budget

- **Container**: `--memory=16g --memory-swap=32g` (16GB RAM + 16GB swap)
- **NODE_OPTIONS**: `--max-old-space-size=3072`
- **Dev agents**: ~2.5GB each
- **Max agents**: up to 8 devs when not running heavy local validation (~500MB each)
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
Opus model, worktree isolation. Implements fixes in `src/` and `tests/`. Pushes a branch and opens a PR so GitHub Actions can run sharded test262 on the integrated branch.

## Team Spawn

Use `TeamCreate` to create the team, then spawn roles:

```
TeamCreate: "js2wasm"
  - developer × 2 max (agent def: .claude/agents/developer.md, isolation: worktree)
  - product-owner on demand (agent def: .claude/agents/product-owner.md)
  - NO tester — PR CI handles test262 validation
```

All teammates can `SendMessage` to each other by name. Devs broadcast file claims and report PR readiness to tech lead.

## Communication Protocol

### Developer → all devs (broadcast)
When starting work:
1. Check `plan/file-locks.md` for conflicts
2. Add claim to the lock table
3. Broadcast: `"Claiming compileCallExpression in expressions.ts for #512"`

When discovering a dependency: `"My fix for #512 requires coerceType change — anyone in type-coercion.ts?"`
On completion: remove claim from `plan/file-locks.md`

### Developer → tech lead
When done: `"Issue #512 complete, PR: <url>, branch: issue-512-call-expressions, commit: abc1234"`
CI runs sharded test262 on PRs and on `main` after merge — devs do NOT run local full test262.

## Worktree Isolation (MANDATORY)

- **ALL agents that write files MUST use `isolation: "worktree"`.** Only read-only agents (Explore, Plan) may skip it.
- **No agent edits main directly.** TTL merges completed work from worktree branches.
- **Tech lead works only at `/workspace` on `main`.** Always verify with `cd /workspace && git branch --show-current` before git ops. Never `cd` into agent worktrees — use `git -C <path>` to inspect.

## Developer Constraints

- **Up to 8 devs** in isolated git worktrees (~500MB each). Local dev work should avoid long-running full-suite validation.
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
  When ready for full validation, push the branch and open a PR.
  GitHub Actions runs sharded `test262` on the PR and on `main` after merge — devs never run local full `test262`.
- **Document findings.** Always write root cause analysis and implementation notes in the issue file before completion.

## Branch + PR Workflow

1. Dev completes the change in a worktree branch
2. Dev merges `main` into the branch and reruns scoped local checks
3. Dev pushes the branch and opens a PR
4. GitHub Actions runs sharded `test262` plus regression diffing on the PR
5. Tech lead reviews and merges once PR checks are green or explicitly overridden
6. The same workflow refreshes the baseline on `main`

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

- **Default conformance path is CI**, not local developer runs
- PRs run the sharded `test262` workflow and diff against the current `main` baseline
- Pushes to `main` rerun the same pipeline and refresh the baseline/report artifacts
- Every skip filter MUST have a corresponding issue
- History tracked in `benchmarks/results/runs/index.json`
- Never delete run data from `benchmarks/results/runs/`

## Merge Lessons

- After merging many branches touching `equivalence.test.ts`, reconstruct by extracting new tests from each branch parent and appending to base
- Always verify with TS parser (`ts.createSourceFile`) before committing reconstructed test files
- Test262 with 3 workers uses ~9GB — 16GB swap absorbs spikes instead of OOM-killing
