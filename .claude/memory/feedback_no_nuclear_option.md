---
name: feedback_no_nuclear_option
description: Never take destructive/irreversible actions without waiting for explicit user confirmation in a separate turn
type: feedback
---

Never take irreversible actions without **waiting for explicit user confirmation in a separate turn**:
- Sending shutdown requests to agents
- Killing agent tmux panes
- Deleting worktrees or files
- Reverting commits

Pattern: ask → **end your response** → wait for user reply → then act.

**"No code changes" does NOT mean stuck.** Devs may be researching, reading .wat files, testing approaches. Don't assume agents are stuck just because they haven't written code in 15 minutes. Research is valid work.

**Why:**
- Killed dev-6 while user was actively talking to it
- Killed 5 "stuck" devs that may have been doing deep research
- Deleted issue files that tracked real work

**How to apply:** Before killing any agent: ask the user "dev-X has no changes after N minutes — should I kill it?" and WAIT for "yes". Don't ask and kill in the same turn.
