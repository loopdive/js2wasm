---
name: Developer agent limits
description: Max 4 devs (3 with test262). Details in plan/team-setup.md — don't duplicate numbers here.
type: feedback
---

See `plan/team-setup.md` for current memory budget and agent limits.

Key rules not in team-setup:
- Each dev writes tests to `tests/issue-{N}.test.ts`, NOT `equivalence.test.ts`
- Diagnostic-only issues (DOWNGRADE_DIAG_CODES) — batch in one commit, no dev agent needed
- Devs update their own issue file but NOT `plan/backlog.md`
- Cherry-pick individual commits, never merge worktree branches

**Why:** Numbers change as hardware/config evolves. Single source of truth in team-setup.md prevents contradictions.
