---
name: feedback_merge_conflict_keep_both
description: When resolving merge conflicts, never blindly take --theirs or --ours. Review both sides.
type: feedback
---

When resolving merge conflicts during branch merges, NEVER use `--theirs` or `--ours` blindly.

**Why:** Earlier in this session, `git checkout --theirs` was used on issue files during merge conflict resolution, which discarded the dev's work updates in favor of main's version. This lost implementation summaries and test results that the dev had written.

**How to apply:**
1. When a merge conflict occurs, `cat` the conflicted file to see both sides
2. Manually merge by keeping content from BOTH sides
3. For issue files: keep the dev's implementation notes AND main's updated counts
4. For source files: understand both changes before choosing
5. Only use `--theirs`/`--ours` when you're certain one side's content fully supersedes the other
