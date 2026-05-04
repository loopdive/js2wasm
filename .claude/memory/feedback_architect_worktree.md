---
name: Architect must use worktree isolation
description: Always spawn architect agents with isolation:worktree to prevent race conditions with concurrent git operations on main
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
Always use `isolation: worktree` when spawning architect agents, even though they only write plan files (no code).

**Why:** The architect runs in `/workspace` (the main working tree) by default. Concurrent git operations by the tech lead (merges, checkouts, resets) lock and rewrite the git index, which can silently discard the architect's uncommitted working-tree edits. The architect then has to redo the work.

**How to apply:** Every `Agent(subagent_type: "architect", ...)` call must include `isolation: "worktree"`. No exceptions, even for short spec-writing tasks.
