---
name: Merge agent branches, don't cherry-pick
description: Merge agent worktree branches to main instead of cherry-picking. Wait for wave to finish, then batch merge.
type: feedback
---

Merge agent worktree branches to main -- do NOT cherry-pick. Wait for all agents in a wave to complete, then merge one at a time.

**Why:** User corrected cherry-pick workflow (2026-03-26). Merge preserves branch history and is the standard git workflow.

**How to apply:**
1. Dispatch wave of agents in worktrees
2. Wait for ALL to complete
3. Merge each branch to main sequentially
4. Push once at the end
5. Dispatch next wave
