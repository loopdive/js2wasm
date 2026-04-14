---
name: sprint-retrospective
description: Run a sprint retrospective — gather data, analyze incidents, propose action items. Any agent can facilitate.
---

# Sprint Retrospective

Reviews the sprint and proposes process improvements.

## Step 1: Gather data

```bash
# Sprint doc
cat plan/issues/sprints/{N}/sprint.md

# Diary entries from this sprint
cat plan/diary.md

# Git history for the sprint
git log --oneline --since="YYYY-MM-DD"

# Recently completed issues
rg -n '^status: done$' plan/issues/*.md | tail -20

# Task completion times (if available)
# Check TaskList or sprint doc task table
```

## Step 2: Identify incidents

For each merge/task, assess:
- **Cycle time**: how long from claim to merge?
- **Friction**: rebase failures, conflict resolution, idle waiting?
- **Quality**: regressions? Tests skipped? Checklist steps missed?
- **Communication**: too many messages? Wrong recipients? Ignored messages?

## Step 3: Categorize

**What went well** — with evidence:
- Which processes worked as designed?
- Which fixes landed cleanly?
- What saved time vs previous sprints?

**What didn't go well** — with root cause:
- Each incident: what happened, why, impact
- Systemic patterns across incidents

## Step 4: Propose action items

For each problem, propose a specific change to a specific file:

| # | Change | File | Priority |
|---|--------|------|----------|
| A1 | {what to change} | {which file} | HIGH/MEDIUM/LOW |

Each action item should be:
- **Specific**: exact file and section to edit
- **Testable**: how do we know it worked next sprint?
- **Small**: one rule change, not a process overhaul

## Step 5: Write retrospective

Write to `plan/issues/sprints/{N}/sprint.md`:

```markdown
# Sprint {N} Retrospective

**Date**: YYYY-MM-DD
**Baseline**: {start numbers}
**Final**: {end numbers}

## What went well
- (with evidence)

## What didn't go well
### Incident 1: {title}
**What happened**: ...
**Root cause**: ...
**Impact**: ...
**Action item**: ...

## Action items summary
| # | Change | File | Priority |
...

## Proposed file edits
(exact diffs for each action item)
```

## Step 6: Review with team

Share the retro with tech lead and user. Don't apply edits unilaterally — propose and wait for approval.

## Output

Message tech lead: `"Sprint-{N} retro complete. {X} incidents, {Y} action items. Review at plan/issues/sprints/{N}/sprint.md"`
