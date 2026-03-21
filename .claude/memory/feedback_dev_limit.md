---
name: Limit developer agents and avoid file conflicts
description: Max 16 concurrent developers, no two developers touching the same function simultaneously
type: feedback
---

- Limit the team to 16 developer agents at a time when executing sprint work.
- No two developers should touch the same *function* concurrently. Multiple agents can touch the same file (e.g. expressions.ts) if they modify different functions — Git 3-way merge handles separate hunks cleanly.
- After a developer finishes and their changes are cherry-picked to main, the next developer's worktree should be based on the updated main so it includes those changes.
- Each developer writes tests to `tests/issue-{N}.test.ts`, NOT to `equivalence.test.ts` (the #1 conflict source).
- Diagnostic-only issues (just adding codes to DOWNGRADE_DIAG_CODES) should be batched into one manual commit — no developer agent needed.
- Developers can update their own issue file (`plan/issues/{N}.md`) but must NOT touch `plan/backlog.md` — update backlog after merging.
- Cherry-pick individual commits to main, never merge worktree branches. Resolve plan/ conflicts with `sed -i '/^<<<<<<</d; /^=======/d; /^>>>>>>>/d'`.
