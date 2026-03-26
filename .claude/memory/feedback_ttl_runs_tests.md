---
name: TTL runs tests, no dedicated tester
description: ONLY the Tech Lead runs tests (npm test, test262). Dev agents must NOT run tests — they validate by compiling individual files only.
type: feedback
---

**ONLY the Tech Team Lead runs tests.** Dev agents must NOT run `npm test`, `pnpm run test:262`, or any vitest command.

- Dev agents validate by compiling specific test files: `timeout 8 npx tsx src/cli.ts <test-file>`
- Dev agents commit and report to TTL when done
- TTL merges, rebuilds bundle, runs tests serially in background
- Never run test262 concurrently with dev agents (OOM risk)
- After a batch of devs completes: use `TEST262_WORKERS=3` for faster measurement (no devs competing for memory)
- During dev work: default 2 workers

**Why:** OOMs happen from test workers + dev agents competing for memory. Dev agents running `npm test` in worktrees use ~4GB each (vitest + workers). At 14GB container limit, one dev running tests can crash everything.

**How to apply:**
- Every dev agent prompt MUST include: "Do NOT run npm test or vitest. Validate by compiling specific test files inline. When ready to test, message the tech team lead and ask them to run tests for you."
- TTL runs tests after merging, or on request from a dev via SendMessage
- Devs should SendMessage to team-lead: "Ready for testing, please run npm test"
