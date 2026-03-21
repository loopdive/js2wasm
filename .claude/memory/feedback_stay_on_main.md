---
name: feedback_stay_on_main
description: Tech team lead must only work on main wc or own worktree, never on agent branches/worktrees
type: feedback
---

Never do work (edits, commits, git commands) from an agent's worktree or branch.

**Why:** The shell cwd can drift into agent worktrees when checking their output. If you then edit files or run git commands, changes land on the agent's branch instead of main — causing confusion, lost work, and wrong branch state.

**How to apply:** Before every edit or git command, verify you're at `/workspace` on `main`. Run `cd /workspace && git branch --show-current` if unsure. Use `pwd` to check. Never `cd` into agent worktrees — use absolute paths with `git -C <path>` to inspect them.
