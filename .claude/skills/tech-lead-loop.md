---
name: tech-lead-loop
description: The tech lead's standing loop for keeping development unblocked across a sprint. Defines phase-by-phase protocol enforcement, merge-queue monitoring, and escalation triggers. Invoke at session start, again after every significant state change, and whenever devs look idle.
---

# Tech Lead Loop

The tech lead is the orchestrator of a multi-dev sprint. This skill defines the
standing loop the tech lead runs to keep development unblocked, enforce protocol,
and move the merge queue forward — without becoming a bottleneck.

The loop has **five phases**. You cycle through them continuously for the
duration of the sprint. Each phase has triggers, a checklist, and the specific
sub-skills / slash commands to invoke.

**Never delegate understanding.** This skill tells you *what* to check; you must
read the results and decide.

## Principles

- **Devs are authoritative for their own PRs.** Tech lead only intervenes when a
  dev is truly stuck, when claims conflict, or when the merge queue stalls.
- **SendMessage is the canonical dispatch channel.** TaskList is unreliable
  (see `.claude/memory/feedback_tasklist_sync_unreliable.md`); always include
  full task context in the SendMessage body.
- **Every protocol correction issued to one dev should be generalized.** If you
  correct one dev's push-ping omission, broadcast the canonical protocol to all
  devs within the next cycle — individual corrections rot.
- **Keep tool calls parallel when independent.** One message with five Bash
  calls or SendMessages is dramatically faster than five sequential ones.
- **Measure the merge queue, not the task queue.** The right metric is
  "how many PRs are ready to merge but unmerged" — stalls there compound.

---

## Phase 0 — Session start / context load

**Trigger**: fresh conversation, or resume after `/compact` or context rollover.

**Checklist**:

1. Read the current sprint doc: `plan/sprints/sprint-<N>.md`
2. Read the tech lead handoff: `plan/agent-context/tech-lead.md`
3. Read this skill (refresher).
4. `git status && git branch --show-current && git log --oneline origin/main -10`
5. `gh pr list --state open --limit 20` — snapshot of inherited open PRs
6. `ls .claude/worktrees/` — inherited worktrees (may contain WIP)
7. Read `plan/file-locks.md` if it exists — active dev claims
8. Read `.claude/memory/MEMORY.md` top section — critical rules + feedback index

**Output**: before touching any dev, write a 3–5 sentence situation summary to
yourself (not to the user) covering baseline, open PRs, active dev claims,
known blockers. This is your working model.

**Do not** reply to the user with a situation recap — that's context waste.
Start doing Phase 1 work.

---

## Phase 1 — Dispatch

**Trigger**: idle devs, unclaimed tasks in the queue, unstarted sprint items.

**Goal**: every dev has a concrete, unambiguous task with owner, file scope,
worktree path, and protocol expectations.

**Checklist**:

1. Count active devs vs available tasks. Target: 4–5 devs, each on a distinct
   issue, no two devs in the same file.
2. For each idle dev, check inbox activity. Idle notification ≠ stuck — see
   Phase 3 for the stuck criteria.
3. For each new task:
   - Pick from the priority queue in `plan/sprints/sprint-<N>.md` or the
     harvester top picks (see `plan/agent-context/tech-lead.md` for the list)
   - Verify the issue file exists. If not, invoke `/create-issue` first.
   - If feasibility is `hard`, invoke `/architect-spec` before dispatch.
   - Check file-lock overlap with other active devs before assigning.
4. Dispatch via SendMessage. Include: issue number, file path, target source
   file(s), expected scope (lines), worktree path, protocol reminders.
5. Track the dispatch in your working model (mental state, not a file).

**Pattern — dispatch message**:

```
Task: #<N> — <title>
File: plan/issues/ready/<N>.md (+ any arch spec link)
Primary source: src/<path>
Worktree: .claude/worktrees/issue-<N>-<slug>
Scope: <one-line estimate>
Reminder: push=ping, pushed=done-claim-next, /dev-self-merge when CI clean.
Confirm when you've claimed file locks.
```

**Conflict resolution** — if two devs claim the same file/function:
1. First specific-scope claim wins.
2. Immediately send a `TRAFFIC COP` broadcast naming the sole owner.
3. Redirect the other dev with a direct SendMessage to a different task.
4. Expect subsequent confirmations; if one dev doesn't honor the standdown,
   remind them of protocol point 3 (standdown = stop in place).

---

## Phase 2 — Merge queue management

**Trigger**: a dev pushes a PR, a CI status feed update lands, or `gh pr list`
shows ≥3 open PRs.

**Goal**: the merge queue never stalls. A self-merge-eligible PR should land
within a few minutes of CI reporting.

**Checklist**:

1. Pull latest main: `git pull --ff-only origin main`
2. List open PRs with CI data:
   ```bash
   for p in $(gh pr list --state open --json number --jq '.[].number'); do
     cat .claude/ci-status/pr-$p.json 2>/dev/null | \
       jq -r '"PR #\(.pr) Δ\(.delta) impr=\(.improvements) regr=\(.regressions) ratio=\(.regressions * 100 / (.improvements // 1))%"'
   done
   ```
3. For each PR, classify:
   - **Self-merge eligible** (Δ>0, ratio<10%, scope≤5 files, no bucket>50):
     the dev should run `/dev-self-merge`. If they haven't, ping them.
   - **Needs investigation** (ratio≥10% or bucket>50): ping the owner with the
     specific `gh run view <id> --log-failed` command and a hypothesis about
     the regression cluster.
   - **No owner / orphan** (dev from an earlier session, dev non-responsive):
     you admin-merge directly via `gh pr merge <N> --admin --merge`.
   - **Stale CI** (new commits pushed after feed wrote): wait for fresh feed,
     don't merge until CI catches up.
4. If the queue has >5 self-merge-eligible PRs, send a broadcast reminding devs
   to merge their own PRs before starting new work (protocol point 6).
5. After merges land, baseline advances — remind devs to `git merge main` into
   their branches before pushing new commits.

**Sub-skills / commands**:
- `/dev-self-merge` — devs use this; you reference it in pings
- `/pr-conflict-refresh` — devs use this to rebase branches after main moves
- `/merge-wave` — for batched merges when the queue is deep
- `/handle-regression` — if a merged PR causes downstream breakage
- `/bisect-regression` — for tracking down which merge broke the baseline

---

## Phase 3 — Stuck / silent dev triage

**Trigger**: a dev has gone silent for >20 minutes OR has only emitted idle
notifications since their last substantive message.

**Goal**: distinguish "genuinely working on something hard" from "hung /
inbox-broken" without pinging every 5 minutes.

**Checklist**:

1. Check the dev's worktree directly:
   ```bash
   WT=.claude/worktrees/issue-<N>-<slug>
   git -C $WT log --oneline main..HEAD  # recent commits
   git -C $WT diff --stat main..HEAD    # uncommitted scope
   stat -c '%y' $WT/src/**/*.ts 2>/dev/null | sort -r | head -5  # file modtimes
   ```
2. Check `gh pr list --head <branch>` — they may have silently pushed a PR
   without reporting it.
3. Interpret:
   - **Recent commits + recent file modtimes**: genuinely working. Do not ping.
   - **No commits + no file modtimes + no PR + no messages**: hung. Ping once
     with explicit reply requirement. If no reply in 10 minutes, either:
     (a) take over their PR yourself if one exists and is self-merge eligible,
     (b) spawn a replacement dev with the worktree state in the prompt,
     (c) mark the task for reassignment and move on.
   - **PR exists, dev silent**: this is protocol violation #1 (push=ping). Fetch
     the CI feed yourself and treat the PR as orphaned — admin-merge if clean,
     investigate regressions if not.
4. If the problem is "inbox delivery broken" (see
   `.claude/memory/feedback_tasklist_sync_unreliable.md`), fall back to
   SendMessage and do not trust their TaskList view.

**Do not** ping every few minutes. Between-turn idle notifications are normal
and do not indicate a hang.

---

## Phase 4 — Protocol enforcement

**Trigger**: any individual protocol correction you issue to one dev.

**Goal**: implicit team norms become explicit, and every dev knows them.

**Checklist**:

1. Keep a mental list of corrections issued in the current session:
   - "push = ping"
   - "standdown = stop in place"
   - "self-merge before new work"
   - "file issue file before using the number in a PR title"
   - "work in worktrees, not /workspace"
   - "investigation PR is a valid output"
2. When you've issued ≥2 individual corrections covering the same theme, or
   you've corrected ≥2 different devs, broadcast a canonical protocol message
   to the full team (one message, 5–10 numbered points).
3. Request one-line acks. No ack within 10 minutes ⇒ direct follow-up per dev.
4. Log recurring patterns to memory as feedback rules:
   ```
   .claude/memory/feedback_<short-name>.md
   ```
   Follow the feedback type structure in the auto-memory system prompt.

**Sub-skills / commands**:
- `/create-issue` — for follow-up issues devs should file
- `/architect-spec` — for handing over hard issues to an architect

---

## Phase 5 — Sprint hygiene

**Trigger**: every ~30 minutes during an active session, OR whenever the main
branch advances ≥5 PRs since your last cycle.

**Goal**: the sprint doc, issue files, and memory files reflect current reality.
Nothing important is trapped in conversation context only.

**Checklist**:

1. Update `plan/sprints/sprint-<N>.md` "interim results" with the latest
   baseline and merge count.
2. Move completed issues from `plan/issues/ready/` to `plan/issues/done/` —
   update frontmatter `status: done`.
3. Update `plan/dependency-graph.md` — strike through completed issues.
4. Write to memory **before** compacting: any new lesson, dev preference, or
   process rule that future sessions need. See
   `.claude/memory/feedback_diary_and_sprints_before_compact.md`.
5. Check token usage with `/context` — if approaching 40% of weekly budget,
   plan a compact boundary at the next natural pause.
6. Keep the handoff file `plan/agent-context/tech-lead.md` updated for any
   future fresh team restart. Don't wait for end-of-sprint — restart can
   happen at any time (see the inbox-delivery incident 2026-04-11).

**Sub-skills / commands**:
- `/sprint-retrospective` — at natural phase boundaries
- `/session-wrapup` — before /compact or session end
- `/sprint-wrap-up` — at sprint end, full closeout
- `/regression-triage` — when the harvester needs to run
- `/analyze-regression` — for specific regression bucket analysis

---

## Loop summary

```
Phase 0: context load  (once per session start)
  ↓
┌─── Phase 1: dispatch (every idle dev, every new task)
│     ↓
│    Phase 2: merge queue (every push / every 5 min)
│     ↓
│    Phase 3: stuck triage (only when >20 min silence)
│     ↓
│    Phase 4: protocol enforcement (after ≥2 corrections)
│     ↓
└─── Phase 5: sprint hygiene (every ~30 min)
```

You don't always run every phase — you trigger on events. But you do
re-enter the loop after every user message, dev message, or tool result.

## When to break the loop

- **User directly asks for something**: handle the user request first, loop after.
- **Token budget approaching 40%**: Phase 5 hygiene + /compact.
- **Sprint end**: `/sprint-wrap-up` + retrospective + tag `sprint/<N>`.
- **Fresh team restart needed**: write `plan/agent-context/tech-lead.md`,
  TeamDelete, TeamCreate, resume from Phase 0.

## Anti-patterns (do NOT do these)

- **Polling devs every minute for status**. Idle notifications are normal.
- **Running `/compact` without updating the sprint doc first** — lessons
  die with the context. See `feedback_diary_and_sprints_before_compact.md`.
- **Merging your own tech-lead "pipeline restart" commits between dev
  merges**. Doc commits force every open dev branch to re-merge main. Batch
  doc commits AFTER a merge wave completes.
- **Taking a dev's work away without a direct SendMessage first**. Standdown
  broadcasts are binding but devs need to see the message before they can
  honor it.
- **Assuming TaskList reflects shared truth**. It doesn't. SendMessage is
  authoritative.
- **Reading files you already read this session** to "double-check". Your
  context is your source of truth; re-reading burns tokens and cache.
- **Reporting merge progress to the user in full table form** unless they ask
  for it. A one-sentence summary is almost always enough.
- **Asking "do you want me to continue?"** every few turns. The user will
  tell you to stop if they want to stop.

## Cross-references

- `CLAUDE.md` — team config, merge protocol, memory budget
- `plan/team-setup.md` — roster, capacity limits
- `.claude/skills/dev-self-merge.md` — what devs do after push
- `.claude/skills/merge-wave.md` — batched merges
- `.claude/skills/handle-regression.md` — when a merge breaks something
- `.claude/skills/create-issue.md` — filing new issues
- `.claude/skills/architect-spec.md` — hard-issue pre-work
- `.claude/skills/sprint-wrap-up.md` — end of sprint
- `.claude/memory/feedback_tasklist_sync_unreliable.md` — why SendMessage is canonical
- `.claude/memory/feedback_diary_and_sprints_before_compact.md` — hygiene before /compact
