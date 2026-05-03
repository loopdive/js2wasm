---
name: merge_carefulness
description: Be careful with merges — git checkout --theirs can silently overwrite recent local edits; always fetch before pushing
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
After taking `--theirs` on planning artifact conflicts, always verify that any local edits to those same files are preserved. Example failure: S48 sprint.md wrap_checklist was set to all-true locally, then `git checkout --theirs` on a conflict in that same file clobbered those edits, sending false values to origin.

**Why:** `git checkout --theirs` replaces the entire file with origin's version — any local edits made after the last commit are lost silently.

**How to apply:**
1. Before `git checkout --theirs <file>`, note which files you've recently edited in this session
2. After resolving conflicts and before committing, `git diff HEAD -- <sensitive-files>` to verify local intent is preserved
3. Always `git fetch origin` before attempting a push — CI auto-commits land frequently and cause non-fast-forward rejections
4. For sprint.md and other living docs: if they appear in a conflict, prefer manual merge over `--theirs` to preserve both sides
