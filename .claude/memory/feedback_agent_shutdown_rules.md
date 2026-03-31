---
name: Agent shutdown rules after sprint planning
description: PO, architect, SM auto-terminate after planning unless user interacted with them directly
type: feedback
---

After sprint planning is complete, PO, architect, and scrum master should:
1. Write context summary to `plan/agent-context/{name}.md`
2. Terminate automatically

**Exception**: If the user interacted with the agent directly during the session, ask the user before shutting it down.

**Why:** These agents consume ~600-800MB each. Keeping them idle wastes RAM needed for dev work and test runs. But the user may still want to talk to ones they've been in conversation with.

**How to apply:** After sprint plan is finalized, check which agents the user talked to directly. Shut down the rest with context summaries. Ask about the ones the user interacted with.
