---
name: feedback_verify_pwd_before_git
description: Always verify pwd=/workspace and branch=main before any git operation on main repo
type: feedback
---

Before ANY git command on the main repo (commit, apply, cherry-pick, merge), run `pwd` and `git branch --show-current` first. Agent operations (apply --3way, cherry-pick) can silently change the cwd to a worktree.

**Why:** Applied a patch while cwd was inside an agent worktree instead of /workspace. The commit went to the wrong branch.

**How to apply:** Start every git operation block with `cd /workspace &&` to ensure correct directory. Never assume cwd is correct after interacting with worktree paths.
