---
name: Update diary and sprint doc before compacting
description: Before running /compact, always append a dated entry to plan/diary.md and update the active plan/sprints/sprint-N.md with current state — even if the sprint isn't final
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Before running `/compact` (especially at sprint boundaries or end-of-session), update TWO files with the current state:

1. **`plan/diary.md`** — append a dated entry covering what happened this session: merges, closes, new issues, incidents, learnings, context/budget observations
2. **`plan/sprints/sprint-N.md`** and/or **`plan/retrospectives/sprint-N.md`** — update the Results section and append a Retrospective section, even if the sprint hasn't officially closed yet (mark it "interim" / "in progress")

**Why:** `/compact` discards conversation-level detail. If you compact without persisting learnings and progress narrative to disk, those learnings die with the conversation. The diary is the living log the project depends on for continuity; the sprint doc is the authoritative record of what shipped vs what was planned.

**How to apply:**
- Treat "update diary + sprint doc" as a checklist step that precedes every `/compact` call
- Same for session end-of-day (even without `/compact`) — write it to disk before the conversation ends
- Keep both updates concise (sections, bullets, minimal prose) — they are change-logs, not essays
- For in-progress sprints, clearly mark interim retros as such so future readers know the sprint didn't officially close

**Corollary:** this is the NON-negotiable version of "write a handoff to `plan/agent-context/tech-lead.md` before ending the session." The agent-context file is optional working notes; diary + sprint doc are the authoritative persistent record.
