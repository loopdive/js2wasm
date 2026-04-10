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

## Step 4: Verify test262 ran on the final state

Check that test262 has been run on the current main (either via CI sharded run
on the last merged PR, or a local run). Do NOT run locally unless CI didn't cover it.

```bash
# Check latest CI test262 run on main
gh run list --workflow=test262-sharded.yml --branch=main --limit 1
# Or check local results
node -e "const r=JSON.parse(require('fs').readFileSync('benchmarks/results/test262-current.json','utf8')); console.log(r.summary.pass, '/', r.summary.total)"
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
