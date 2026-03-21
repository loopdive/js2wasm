---
name: Don't dispatch agents at high usage
description: Stop launching new developer agents when token/context usage is above 90%
type: feedback
---

Do not dispatch new developer agents when context/token usage is above 90%. At that point, only cherry-pick completed work and wrap up.

**Why:** Launching agents near the context limit risks running out of tokens before work can be consolidated, leading to lost progress and orphaned worktrees.

**How to apply:** Before launching any new dev agent, check remaining context budget. If above 90% usage, stop the rolling pool and focus on cherry-picking completed agents only.
