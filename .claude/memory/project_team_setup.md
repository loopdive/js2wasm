---
name: Team Setup
description: Max 2 devs as teammates, TTL runs tests, PO on demand. Details in plan/team-setup.md.
type: project
---

Team structure via `TeamCreate`:
- **2 dev teammates max** (worktree isolation, any task)
- **PO on demand** (spawn when plan/ needs updating, shut down when idle)
- **No tester teammate** — TTL runs tests directly in background
- Container: 14GB RAM, 28GB swap

Full config: `plan/team-setup.md`

Key decisions:
- Devs broadcast file claims on start
- TTL runs tests serially after merges (prevents OOM)
- PO only touches `plan/` directory
- TTL merges branches to main (not cherry-pick)
