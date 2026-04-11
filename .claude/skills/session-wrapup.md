---
name: session-wrapup
description: End-of-session checkpoint — append diary, update active sprint doc with interim results/retro, write tech-lead handoff, commit and push. Use before /compact or at end-of-day. Distinct from sprint-wrap-up which closes a sprint.
---

# Session Wrap-Up

Persist all session-level learnings and state to disk BEFORE running `/compact` or ending a session. Ensures nothing is discarded with the conversation.

## When to use

- At end-of-day / session end (user signals "we're done for today")
- Before running `/compact` (especially mid-sprint)
- After a long merge wave or planning session
- When approaching a token budget threshold (≥40% weekly)

**Distinct from `sprint-wrap-up`** which is for closing a sprint with retrospective + tagging. This skill is for routine session ends while a sprint is still active.

## Step 1: Verify on main in /workspace

```bash
pwd && git branch --show-current
```

Must be `/workspace` on `main`. Abort if not.

## Step 2: Append to plan/diary.md

Add a new `## YYYY-MM-DD HH:MM — <brief title>` section at the bottom with:

- **Pass rate** — start and end numbers if changed
- **Merges** — PRs that landed, with net deltas
- **Closes** — PRs rejected, with reasons
- **New issues filed** — numbers + one-line purpose
- **Incidents** — OOM, stuck processes, false-positive regressions, CI glitches
- **Context/budget** — tokens burned, triggers, mitigations applied
- **Key learnings** — non-obvious findings worth saving (1-sentence each)

Keep it to ~30-60 lines. Bullets, not prose.

## Step 3: Update plan/sprints/sprint-N.md

Fill the `## Results` section (mark as "interim" if sprint still active):

```markdown
## Results (interim — YYYY-MM-DD, sprint still active)

**Baseline progress:** <start> → **<end>** pass / <total> total = **<pct>%** (<+delta>)
Sprint goal (<goal>) <met|not yet met>. <gap> tests <remaining>.

### Merged
- **#NNN <title>** (<PR>, <+delta> pass)
...

### Closed without merging
- **#NNN <reason>**
...
```

And if the sprint has a `## Retrospective` section, append an interim retro with "What went well / What went badly / Process improvements / Key numbers / Sprint-close criteria remaining".

## Step 4: Write/update plan/retrospectives/sprint-N.md

If a retrospective file doesn't exist yet, create one with frontmatter:

```markdown
---
sprint: Sprint-N
status: interim | final
session_end: YYYY-MM-DD
---

# Sprint N Retrospective — INTERIM (sprint still active)
```

Then fill with the same what-went-well / badly / process-improvements sections. Mark "interim" clearly if sprint isn't closed yet.

## Step 5: Update plan/agent-context/tech-lead.md

```markdown
---
agent: tech-lead
session_end: YYYY-MM-DD
next_session_entry_point: read this file, then plan/sprints/sprint-N.md
---

# Tech Lead Context Summary — YYYY-MM-DD

## Baseline state
## Sprint N status
  ### Merged today
  ### Closed
  ### PRs still in flight
  ### Unassigned ready work (prioritized)
## Team state
## Local state needing push
## Unfinished work / loose ends
## Entry points for next session
```

This file is what the NEXT session reads as its first tool call instead of `claude --resume`. Be thorough — ~100-200 lines of actionable bullets.

## Step 6: Stage and commit

```bash
git add plan/diary.md plan/sprints/sprint-N.md plan/retrospectives/sprint-N.md plan/agent-context/tech-lead.md
git diff --cached --stat
git commit -m "docs(session): end-of-session checkpoint — YYYY-MM-DD

CHECKLIST-FOXTROT

Persist session learnings to disk before /compact.
- plan/diary.md: <summary>
- plan/sprints/sprint-N.md: <summary>
- plan/retrospectives/sprint-N.md: <interim|final>
- plan/agent-context/tech-lead.md: handoff for next session

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

## Step 7: Push

```bash
git pull --rebase origin main 2>&1 | tail -3
git push origin main 2>&1 | tail -3
```

If the rebase gets stuck mid-pick with "editing commit" state, run `git rebase --continue` — it's a transient git state-machine glitch from empty-after-rebase detection.

## Step 8: Tell the user

Short summary:
```
Pre-compact snapshot committed (<commit-hash>). Pushed.
Next session: read plan/agent-context/tech-lead.md, do NOT --resume this session.
Safe to /compact now.
```

## Notes

- **Never skip step 2 and 3.** Diary + sprint doc are the persistent project log. Compacting without updating them loses the session's learnings permanently.
- **tech-lead.md is NOT optional** — it's the handoff channel that replaces session resume. Write it every time you end a long session.
- **Don't wait for sprint close** to fill retrospective sections. Interim retros are fine; the sprint doc carries multiple interim entries over time.
- **Interim retro files are allowed** — mark `status: interim` in the frontmatter. When the sprint closes, update to `status: final` and amend.
