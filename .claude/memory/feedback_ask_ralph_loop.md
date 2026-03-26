---
name: feedback_ask_ralph_loop
description: At conversation start, ask if a Ralph loop should be started for the current goals
type: feedback
---

At the start of every conversation, after checking state, ask the user:
"Should I start a Ralph loop to work on [current active goals] until they're met?"

**Why:** User wants autonomous iteration on goals without manually setting up the loop each time.

**How to apply:** After initial state check, propose a Ralph loop with the active goals and ask for confirmation before starting.
