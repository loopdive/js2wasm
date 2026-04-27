---
name: Team Setup
description: Agent team configuration — PO and Developer roles with worktree isolation and PR-based CI workflow
type: project
---

# Team Setup

## Overview

All agents run as **teammates** in a single team (not subagents). This enables direct messaging between developers and PO for coordination — especially file conflict avoidance.

## Memory Budget

- **Container**: `--memory=16g --memory-swap=32g` (16GB RAM + 16GB swap)
- **NODE_OPTIONS**: `--max-old-space-size=3072`
- **Dev agents**: ~700MB peak (no local test262 — CI handles it)
- **Max agents**: up to 8 devs in parallel
- **Stop dispatching** above 90% context/token usage
- Check `free -h` before launching agents

## Roles

### Project Lead (human)
Owns architecture and vision. Challenges assumptions. Delegates implementation but steers design.

### Tech Lead (orchestrator)
Opus model, works at `/workspace` on `main`. **Owns everything outside `plan/`**.
- **Populates TaskList** at sprint start and whenever new issues are added mid-sprint
- Monitors merge queue, resolves conflicts, handles escalations
- Moves issue files `ready/` → `done/` after merge

### Product Owner (teammate)
Opus model. **Only touches `plan/` directory.** Creates/updates issues, manages backlog, analyzes results.

### Developer (teammate, worktree)
Opus model, worktree isolation. Implements fixes in `src/` and `tests/`. Opens PRs → CI validates → self-merges if green → claims next TaskList task.

## Team Spawn

```
TeamCreate: "js2wasm"
  - developer × up to 8 (agent def: .claude/agents/developer.md, isolation: worktree)
  - product-owner on demand (agent def: .claude/agents/product-owner.md)
  - NO tester — PR CI handles test262 validation
```

## Communication Protocol

Agents message **specific agents only** (no broadcasts unless claiming a shared file).
Message only what the recipient needs to act on.

### When a dev contacts tech lead
Only for:
- TaskList is empty (no next task available)
- Blocked >30 min and can't self-unblock
- CI regressions >50 in a bucket that can't be explained
- Escalated merge (criteria in `/dev-self-merge`)

### When devs coordinate with each other
Only to claim a shared file/function that would conflict:
- `"Claiming compileCallExpression in expressions.ts for #512"` (direct to any dev in that file)
- `"My fix requires a coerceType change — are you in type-coercion.ts?"` (direct to the dev you suspect)

**Never message tech lead for**: completion, CI status, progress updates, "ready for merge". TaskList and CI feed handle those.

## Worktree Isolation (MANDATORY)

- ALL writing agents use `isolation: "worktree"`. Read-only agents may skip it.
- No agent edits `/workspace` directly. Devs work in `/workspace/.claude/worktrees/<branch>/`.
- Tech lead works only at `/workspace` on `main`. Never `cd` into agent worktrees — use `git -C <path>` to inspect.

## Developer Constraints

- **Up to 8 devs** in isolated worktrees (~700MB each).
- **Same-file is OK if different functions.** Avoid parallel work on the *same function*.
- **Each dev writes tests to `tests/issue-{N}.test.ts`.** Never append to `equivalence.test.ts`.
- **Validate by compiling + running specific failing tests** — do NOT run `npm test` or `vitest`.
- **No local test262.** Push a PR and wait for CI.
- **Document findings** in the issue file before completion.

## Branch + PR Workflow

1. Dev implements fix in worktree branch
2. `git fetch origin && git merge origin/main` — merge main into branch before PR
3. Run scoped local checks (compile + run issue-specific tests)
4. `git push origin <branch>` + `gh pr create --base main`
5. Wait for `.claude/ci-status/pr-<N>.json` with matching SHA
6. Run `/dev-self-merge` — self-merge if criteria pass, escalate to tech lead if not
7. After merge: `TaskUpdate` → completed, claim next task from TaskList

## TaskList Protocol

- **Tech lead populates TaskList** at sprint start from `plan/issues/ready/` and whenever new issues are created mid-sprint
- **Devs claim tasks** via `TaskUpdate(owner: "name")` — lowest ID first
- **Devs mark completed** via `TaskUpdate(status: completed)` immediately after merge
- **If TaskList is empty**: dev messages tech lead — this is the one case where contacting tech lead for "no work" is appropriate

## Issue Lifecycle

### Completion procedure (tech lead, post-merge)
1. Move `ready/{N}.md` → `done/{N}.md`
2. Add `completed: YYYY-MM-DD` frontmatter + `## Implementation Summary`
3. Update `plan/log/dependency-graph.md`
4. Check if any blocked issues are now unblocked — add them to TaskList

## Test262

- **All conformance validation runs in CI** (GitHub Actions, sharded)
- PRs diff against the current `main` baseline
- Every skip filter MUST have a corresponding issue
- History in `benchmarks/results/runs/index.json` — never delete

## Merge Lessons

- Branches touching `equivalence.test.ts` in parallel need reconstruction on merge — extract new tests from each branch parent and append to base
- Verify reconstructed test files with TS parser before committing
