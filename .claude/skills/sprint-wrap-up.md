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

## Step 5: Push sprint/N end tag

```bash
git tag sprint/N  # replace N with sprint number
git push origin sprint/N
```

This is required for `build:pages` stats to compute sprint duration and commit counts correctly.

## Step 6: Update sprint doc

Edit `plan/issues/sprints/{N}/sprint.md`:
- Fill in final test262 numbers
- Calculate delta from baseline
- Note any deferred tasks
- **Set `status: closed`** — this is the canonical signal that the sprint is done

## Step 7: Spawn SM for retrospective

Spawn the scrum-master agent to write `plan/log/retrospectives/sprint-{N}.md`. The SM reads:
- `plan/issues/sprints/{N}/sprint.md` — results, deferred tasks
- `git log sprint-{N}/begin..sprint/{N}` — what landed
- Previous retro for format reference

The retrospective must exist before the sprint is considered closed. A "record sprint results" commit without a retro file is **not** a complete wrap-up.

## Step 8: Update diary

Append entry to `plan/diary.md` with sprint summary (baseline, net tests, key wins, carry-overs).

## Step 9: Run test262 error harvest

Before closing the sprint, run the `harvest-errors` skill to cluster any new failure patterns that surfaced during the sprint and file issues for them. This keeps the next sprint's backlog populated with concrete, actionable work instead of requiring manual triage.

```
Invoke the harvest-errors skill (or spawn a dedicated harvester agent)
```

The harvester:
- Clusters failures in `benchmarks/results/test262-current.jsonl` by normalized error pattern
- Cross-references with existing issues in `plan/issues/`
- Files new issue files in `plan/issues/` for unaddressed buckets above the threshold (default: >50 occurrences)
- Reports a summary table

Commit any newly-filed issues before Step 8.

**Why here and not at sprint kickoff:** after the sprint's merges have landed, the failure distribution has shifted — running harvest at wrap-up captures the *current* gaps, not stale pre-sprint ones. The next sprint's planning session (PO) can then slice the fresh issue list by theme. See memory: `feedback_harvest_at_sprint_end.md`.

## Step 10: Update session memory

Update `/home/node/.claude/projects/-workspace/memory/project_next_session.md` with:
- Final git hash
- Test262 numbers
- What's still open
- Key learnings

## Step 11: Commit everything

```bash
git add plan/issues/sprints/{N}/sprint.md plan/diary.md plan/log/retrospectives/sprint-{N}.md
git commit -m "chore(sprint-{N}): close sprint — retro, diary entry, status closed [CHECKLIST-FOXTROT]"
```

## Step 12: Push

```bash
git push
```
