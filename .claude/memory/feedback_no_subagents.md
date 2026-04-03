---
name: feedback_no_subagents
description: Session violation — all devs spawned as subagents instead of teammates, and interfered with running agent's worktree
type: feedback
---

Never commit on a running agent's worktree — it causes conflicts and corrupts their work.

**Why:** In this session, all devs were spawned as bare `Agent` calls (subagents) instead of via `TeamCreate` + `team_name` (teammates). One agent was still running when the tech lead committed on its branch, causing divergent state. Subagents also can't be messaged or coordinated.

**How to apply:** 
1. Always use `TeamCreate` + `Agent` with `team_name` parameter per CLAUDE.md rules
2. Never touch a running agent's worktree — wait for it to finish or send it a message
3. If an agent appears stuck, check output growth rate before intervening
