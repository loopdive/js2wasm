---
name: Always cd /workspace before git commands
description: Never run git commands from agent worktree directories — always prefix with cd /workspace &&
type: feedback
---

When checking agent worktree output, the shell cwd can end up inside a worktree directory. All git commands on main must use `cd /workspace &&` prefix to avoid operating on the wrong branch.

**Why:** Running `git cherry-pick` from a worktree directory operates on that worktree's branch, not main. This causes wrong-branch commits and confusing state.

**How to apply:** Always use `cd /workspace && git ...` for any git operation targeting main.
