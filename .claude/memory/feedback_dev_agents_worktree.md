---
name: All agents must use worktrees
description: ALL agents (dev, PO, any) must use worktree isolation — another agent controls the main working copy
type: feedback
---

ALL agents must NEVER make changes directly on the main working copy. Always use `isolation: "worktree"` when launching any agent that writes files. The main working copy is controlled by another agent.

**Why:** Multiple agents editing the main working copy causes stash conflicts, reverted files, and broken state. Another agent actively controls main.

**How to apply:** Always set `isolation: "worktree"` on any agent that creates/edits files (developer, general-purpose, product-owner). Only read-only agents (Explore, Plan) can skip worktree isolation.
