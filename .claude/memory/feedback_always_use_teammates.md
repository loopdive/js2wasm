---
name: feedback_always_use_teammates
description: Always create a team (devs + PO on demand), TTL runs tests directly, max 2 devs
type: feedback
---

At session start when acting as TTL:
1. `TeamCreate` a team
2. Spawn **2 dev** teammates max for the first issues (with worktree isolation)
3. Spawn **PO** on demand when issues need updating (shut down when idle)
4. **No tester teammate** — TTL runs tests directly in background

Never use solo Agent spawns without `team_name`.

**Why:** OOMs come from test262 workers + dev agents competing for memory. A tester teammate adds its own process overhead on top. The TTL can run tests serially in background and report results. PO generates idle noise when not needed — spawn on demand.

**How to apply:** TeamCreate → spawn 2 devs → TTL runs tests after merges. Spawn PO only when plan/ needs updating. Max 2 devs hard limit (14GB container).
