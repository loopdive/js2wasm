---
name: Serialize cherry-picks, let agents test
description: Don't cherry-pick while agents are running — wait for all agents in a wave to finish, then batch cherry-pick. Agents should still run their own tests.
type: feedback
---

Agents should keep testing their changes in their worktrees. But cherry-picking to main must be serialized — wait for all agents in a wave to complete, then batch cherry-pick one at a time. Don't cherry-pick while other agents are still running, as it causes git lock contention, stale branch issues, and merge conflicts.

**Why:** Concurrent git operations on main (cherry-pick, stash, checkout) while agents are committing to worktree branches causes index.lock conflicts, wrong-branch commits, and messy state.

**How to apply:**
1. Dispatch wave of 4 agents
2. Wait for ALL to complete
3. Then cherry-pick each one sequentially to main
4. Push once at the end
5. Dispatch next wave
