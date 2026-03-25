---
name: test262-runner-usage
description: Always use vitest runner (pnpm run test:262), 2 workers default, 4 OK without agents
type: feedback
---

Always use `pnpm run test:262` (vitest-based runner) — not the legacy `npx tsx scripts/run-test262.ts`.

**Why:** The vitest runner uses esbuild-bundled compiler (lighter per-fork memory), proper disk cache, and auto-worktree. The legacy standalone runner had worker OOM issues (workers got 25K tests in one batch, no recycling). Fixed with 500-test sub-batches and 4GB workers, but vitest runner is the maintained path.

**How to apply:**
- Default: `TEST262_WORKERS=2 pnpm run test:262` (safe at 15GB with dev agents)
- Solo: `TEST262_WORKERS=4 pnpm run test:262` (OK when no dev agents running)
- Never use 8 workers (the old default) — OOMs at 15GB
- Legacy runner: only for `--recheck` or category filtering if vitest runner lacks those features
