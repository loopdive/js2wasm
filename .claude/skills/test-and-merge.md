---
name: test-and-merge
description: Dev self-merge pipeline — merge main into branch, equiv tests, CI wait, self-merge via /dev-self-merge. Run by devs, not a separate tester agent.
---

# Test and Merge Pipeline

**Devs run this themselves after implementing a fix.** There is no separate tester agent — CI handles test262, and devs self-merge when CI passes.

## Step 1: Merge main into branch

```bash
cd /workspace/.claude/worktrees/<branch>
git fetch origin && git merge origin/main
```

- **Clean merge**: proceed
- **Conflicts in `dashboard/`, `plan/`, `public/`**: `git checkout --theirs <file>`, then `pnpm run build:planning-artifacts`
- **Conflicts in `src/**/*.ts`**: create `[CONFLICT]` task in TaskList for senior-developer. STOP.

## Step 2: Run equivalence tests

```bash
npm test -- tests/equivalence.test.ts
```

All equivalence tests must pass. Any new failure = regression, fix before pushing.

## Step 3: Push and open PR

```bash
git push origin <branch>
gh pr create --base main --title "fix(#N): <description>" --body "..."
```

## Step 4: Wait for CI

Use a foreground blocking loop — keeps the agent occupied until CI result lands:

```bash
until [ -f /workspace/.claude/ci-status/pr-<N>.json ] && \
  [ "$(jq -r '.head_sha' /workspace/.claude/ci-status/pr-<N>.json)" = "$(git rev-parse HEAD)" ]; \
  do sleep 60; done
```

## Step 5: Self-merge via /dev-self-merge

Run `/dev-self-merge <N>` — outputs MERGE or ESCALATE.

- **MERGE**: `gh pr merge <N> --merge --admin`
- **ESCALATE**: message tech lead with criterion, values, PR number

## Step 6: Post-merge cleanup

1. `git worktree remove /workspace/.claude/worktrees/<branch>`
2. `TaskUpdate(status: completed)`
3. `TaskList` → claim next task, or shut down if queue is empty
