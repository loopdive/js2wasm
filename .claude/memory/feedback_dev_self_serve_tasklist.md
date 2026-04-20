---
name: Devs self-serve next task from TaskList after merge
description: After a dev's PR merges, they claim the next unowned task from TaskList themselves — tech lead does not re-dispatch. Devs wait (idle) for CI after pushing, self-merge when clean, THEN claim next.
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
**Dev protocol: push PR → wait for CI (idle) → self-merge → claim next task.**

After opening a PR, devs wait (no context activity, no next task) for `.claude/ci-status/pr-<N>.json` to appear with a matching SHA. Then:
- `net_per_test > 0`, ratio <10%, no bucket >50 → `gh pr merge <N> --admin --merge`
- regressions → fix on branch, push, wait again
- escalate to tech lead only for: regressions >10, bucket >50, judgment call

Only after the PR is merged: mark task `completed`, claim next from TaskList.

**Why:** Moving to the next task while waiting for CI means two task contexts accumulate in the agent simultaneously, burning tokens on dual-context overhead. The wait is idle and free; the merge is bounded and necessary. Keeping tasks sequential keeps context clean.

**How to apply:**
- Tech lead must keep `TaskList` populated so there's always work after each merge
- Each task entry must reference a `plan/issues/NNNN.md` with full context — devs shouldn't need a briefing message
- Dev protocol on completion:
  1. Merge `origin/main` into branch, push, `gh pr create`
  2. Poll `.claude/ci-status/pr-<N>.json` every 60s until SHA matches HEAD
  3. Self-merge or fix regressions
  4. After merge: `TaskUpdate status=completed`, then `TaskList` → claim next unowned task
- Dev should escalate to tech lead for: blockers, regressions >10, file-lock conflicts, scope questions
- Dev should NOT message tech lead for: "what's next after this merge" — just claim from the list

**Corollary for the tech lead:**
- When queuing work, prefer `TaskCreate` + broadcast over individually messaging each idle dev
- Treat idle notifications as a signal to check the TaskList, not as a trigger to compose a personalized dispatch message
- Brief a dev individually only for one-off / urgent infra work (e.g., CI hotfix) that isn't in the normal queue
