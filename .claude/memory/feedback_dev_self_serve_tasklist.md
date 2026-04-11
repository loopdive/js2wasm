---
name: Devs self-serve next task from TaskList after merge
description: After a dev's PR merges, they claim the next unowned task from TaskList themselves — tech lead does not re-dispatch
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
When a dev's PR merges to main, they should **immediately claim the next unowned task from TaskList** without waiting for the tech lead to assign it. The tech lead's job is to keep the TaskList populated and prioritized; the dev's job is to keep shipping.

**Why:** Waiting for tech lead orders after every merge wastes context and idle time. Dev agents are expensive — idle devs are burning RAM for nothing. Auto-claim keeps the pipeline moving continuously and lets the tech lead focus on merge decisions, PR review, and filing new issues instead of routine dispatch.

**How to apply:**
- Tech lead must keep `TaskList` populated with real, unowned tasks so there's always work available
- Each task entry must reference a `plan/issues/ready/NNNN.md` with full context — devs shouldn't need a briefing message
- Dev protocol on merge:
  1. `TaskList` → find lowest-ID unowned pending task
  2. `TaskUpdate owner=self, status=in_progress`
  3. Read the issue file for context
  4. Fresh worktree + branch, work, PR, idle, repeat
- Dev should still message tech lead for: PR review/merge, blockers, suspected false-positive regressions, file-lock conflicts, scope questions
- Dev should NOT message tech lead for: "what's next after this merge" — just claim from the list

**Corollary for the tech lead:**
- When queuing work, prefer `TaskCreate` + broadcast over individually messaging each idle dev
- Treat idle notifications as a signal to check the TaskList, not as a trigger to compose a personalized dispatch message
- Brief a dev individually only for one-off / urgent infra work (e.g., CI hotfix) that isn't in the normal queue
