---
name: feedback_check_before_cleanup
description: CRITICAL — Always check worktrees for uncommitted changes before removing. Violated twice in this session.
type: feedback
---

**NEVER delete worktrees without checking diffs first. No exceptions. Not even under time pressure.**

This rule was violated TWICE in the same session despite being memorized. The pattern: urgency ("vitest hangs, need to clean worktrees") overrides the check step.

**Why:** Agent worktrees contain uncommitted work that can't be recovered after deletion. Lost the full test runner with pool/source maps once. Can't verify what was lost the second time because the evidence was already destroyed.

**How to apply:** Before ANY `git worktree remove`:
1. Run `git -C <worktree> diff --stat` for EACH worktree
2. Show the output to the user
3. Ask "anything worth keeping?"
4. ONLY THEN delete

If you catch yourself writing `for wt in ... remove` without the check loop above, STOP.
