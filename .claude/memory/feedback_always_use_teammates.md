---
name: feedback_always_use_teammates
description: Always create a team (max 4 devs + PO on demand), never use bare subagents
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
At session start when acting as TTL:
1. `TeamCreate` with fixed team name **`dev-team`** (reuse across sprints — no sprint-N naming)
2. Spawn up to **4 dev** teammates (with worktree isolation + bypassPermissions)
3. Spawn **PO** on demand when issues need updating
4. **No tester teammate** — TTL runs tests directly in background

**NEVER** use solo `Agent` spawns without `team_name`. Subagents can't coordinate — they OOM from concurrent test runs and duplicate work.

**Why:** Teammates can message each other to serialize test runs (only 1 runs equiv tests at a time). They can coordinate on file conflicts. The team lead merges their work.

**How to apply:** TeamCreate → spawn devs with team_name → teammates coordinate via SendMessage → TTL merges after completion. Spawn PO only when plan/ needs updating. Max 4 devs (20GB container, each ~2GB RSS).
