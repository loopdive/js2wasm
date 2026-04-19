---
name: Devs self-serve next task from TaskList after merge
description: After a dev's PR merges, they claim the next unowned task from TaskList themselves — tech lead does not re-dispatch
type: feedback
originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---
**Dev protocol: "pushed = done, claim next NOW — do not wait for merge."**

As soon as a dev has pushed their branch and opened a PR, they should **immediately** mark their current task `completed` in TaskList and claim the next unowned task. They do NOT wait for:

- CI to pass
- Tech lead to review
- Tech lead to merge
- Tech lead to send a "merged, do next" message

The merge happens asynchronously in the background. If CI fails or the PR needs revision, the tech lead will ping the dev to context-switch back — that is a **rare, exceptional** event. The default flow is "push and move on." Never block on merge confirmation.

**Why:** Waiting for tech lead orders after every merge wastes context and idle time. Dev agents are expensive — idle devs are burning RAM for nothing. Auto-claim keeps the pipeline moving continuously and lets the tech lead focus on merge decisions, PR review, and filing new issues instead of routine dispatch.

**How to apply:**
- Tech lead must keep `TaskList` populated with real, unowned tasks so there's always work available
- Each task entry must reference a `plan/issues/NNNN.md` with full context — devs shouldn't need a briefing message
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
