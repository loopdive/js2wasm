---
name: test262-recheck-default
description: Default to --recheck when running test262, don't edit runner script on main
type: feedback
---

Default to `npx tsx scripts/run-test262.ts` (recheck mode). Use `--full` only for new baselines after major changes. Use `npm test` for vitest.

**Why:** Full runs take ~30 min. Recheck re-runs only fail/CE (~10 min). The runner writes to runs/{timestamp} and promotes on success, so interrupted runs don't corrupt the stable report.

**How to apply:**
- Don't edit `scripts/run-test262.ts` directly on main — use a worktree to avoid conflicts with the tech lead agent
- The PO/tester role monitors runs and creates issues, doesn't modify src/ or scripts/ on main
