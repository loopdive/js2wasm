---
name: Team Setup
description: Up to 8 devs when no tests running, TTL runs tests, PO on demand. Details in plan/method/team-setup.md.
type: project
---

Team structure via `TeamCreate`:
- **Up to 8 dev teammates** when no tests running (worktree isolation, any task, ~500MB each)
- **PO on demand** (spawn when plan/ needs updating, shut down when idle)
- **No tester teammate** — TTL runs tests directly in background
- Container: 16GB RAM, 32GB swap

Full config: `plan/method/team-setup.md`

Key decisions:
- Devs broadcast file claims on start
- TTL runs tests serially after merges (prevents OOM)
- PO only touches `plan/` directory
- TTL merges branches to main (not cherry-pick)
