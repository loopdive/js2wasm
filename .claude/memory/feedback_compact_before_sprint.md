---
name: Run /compact at sprint boundaries
description: Before starting a new sprint (sprint planning, sprint kickoff), run /compact so the new sprint starts with a lean context instead of carrying accumulated tool-call noise
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Run `/compact` at the natural break between sprints — after sprint wrap-up / before sprint planning / before the first dispatch of a new sprint.

**Why:** A long tech-lead session accumulates hundreds of tool calls (merge triage, regression analysis, PR reviews, file diffs, rebase output). Every subsequent tool call re-pays the full history as input tokens, so the per-action cost climbs linearly with context size. On the day we hit 43% of the weekly budget in the first day, the dominant driver was long context from a single sprint-40 merge wave + sprint-41 planning session that spanned ~150+ tool calls in one continuous conversation.

Sprint boundaries are the right breakpoint because:
- The sprint's decisions are already persisted to `plan/sprints/sprint-N.md`, issue files, and git history
- New sprint work doesn't need the prior sprint's merge-by-merge narration
- Memory files + CLAUDE.md carry forward the rules; the conversation-level detail is disposable

**How to apply:**
- After /sprint-wrap-up runs, call /compact before pivoting to sprint planning
- If sprint planning and sprint kickoff happen in the same session, compact between them too
- Don't wait for the context to feel slow — by then you've already burned the budget
- One `/compact` is cheaper than 50 subsequent full-context tool calls

**Corollary — split sessions by phase where possible:**
- A planning session decides *what* to do and persists it in issue files / TaskList
- A separate execution session reads those artifacts and does the work
- Neither carries the other's noise, and each starts lean
