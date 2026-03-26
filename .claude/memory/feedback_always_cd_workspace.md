---
name: Git safety on main
description: Always cd /workspace, verify branch=main, never work from agent worktrees
type: feedback
---

Before ANY git command or file edit on the main repo:
1. `cd /workspace && git branch --show-current` — verify you're on main
2. Never `cd` into agent worktrees — use `git -C <path>` to inspect them
3. Never edit files or run git commands from an agent's worktree directory

**Why:** Shell cwd drifts into agent worktrees when checking output. Commits, cherry-picks, and edits then land on the wrong branch. Happened multiple times.

**How to apply:** Prefix every git operation with `cd /workspace &&`. Use absolute paths with `git -C` for worktree inspection.
