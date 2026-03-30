---
name: sprint-wrap-up
description: End-of-sprint checklist — finalize results, clean up worktrees, update docs, prepare for retro. Any agent can run this.
---

# Sprint Wrap-Up

Run this when all sprint tasks are done or the sprint is being closed.

## Step 1: Verify all tasks are merged or closed

```bash
# Check TaskList for any in_progress or pending tasks
```

For each unmerged task: either merge it (use /test-and-merge) or document why it's deferred.

## Step 2: Clean up worktrees

```bash
ls /workspace/.claude/worktrees/
```

For each worktree:
- Check for uncommitted work: `git -C <wt> diff --stat`
- Check for unmerged commits: `git -C <wt> log --oneline main..HEAD`
- If all merged: `git worktree remove --force <wt>`
- If unmerged: document in the issue file as Suspended Work

## Step 3: Clean up branches

```bash
git branch | grep -v '^\*'
```

Delete branches that are fully merged. Keep branches with unmerged work.

## Step 4: Run final test262

```bash
# Shut down all dev agents first (free RAM)
free -m | awk '/Mem/{print $4}'  # need >4GB
pnpm run test:262
```

Record results in sprint doc.

## Step 5: Update sprint doc

Edit `plan/sprints/sprint-{N}.md`:
- Fill in final test262 numbers
- Calculate delta from baseline
- Note any deferred tasks

## Step 6: Update diary

Append entry to `plan/diary.md` with sprint summary.

## Step 7: Update session memory

Update `/home/node/.claude/projects/-workspace/memory/project_next_session.md` with:
- Final git hash
- Test262 numbers
- What's still open
- Key learnings

## Step 8: Commit everything

```bash
git add plan/sprints/ plan/diary.md plan/dependency-graph.md
git commit -m "chore: sprint-{N} wrap-up — [pass count] pass ([rate]%)"
```

## Step 9: Push

```bash
git push
```
