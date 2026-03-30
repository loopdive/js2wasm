# Sprint 30 Retrospective

**Date**: 2026-03-29
**Baseline**: 18,284 pass / 48,088 total (38.0%)
**Final**: 18,599 pass / 48,088 total (38.7%) — +315 pass, -64 CE
**Team**: 3 devs + blog agent + tech lead

## What went well

1. **ff-only merge protocol works** — caught stale bases multiple times, prevented silent breakage. First merge (#846) caught a stale base, agent rebased successfully. This saved us from the kind of silent regressions that plagued earlier sprints.

2. **Checklists created and partially validated** — pre-commit, pre-completion, pre-merge, and session-start checklists were created mid-sprint. The pre-commit checklist's "check for accidental deletions" rule would have caught the #822 stale rebase deletions if followed.

3. **Issue audit before dispatch saved cycles** — after discovering 3 already-fixed issues (#824, #857, #850), the team switched to audit-first, preventing further wasted work.

4. **Clean merges for 5 issues** — #848 (class computed props), #847 (for-of destructuring), #846 (assert.throws), #827 (Array callbacks), #852 (destructuring null_deref) all merged without regressions.

5. **Communication discipline defined** — broadcast only for file claims, everything else to tech lead. Reduced noise significantly compared to earlier sprints.

6. **verifyProperty diagnosis** — dev-3 identified a high-leverage root cause (Object.getOwnPropertyNames returning externref) that could unblock hundreds of tests. Good exploratory work routed to the right issue (#822).

7. **Results archiving** — test262 runner now archives previous JSONL before each run, enabling regression analysis between any two runs.

## What didn't go well

### Incident 1: #822 merged twice, reverted twice (+8,400 CE then +6,822 CE)

**What happened**: dev-1's #822 fix was merged and caused +8,400 compile errors (pass count: 18,284 → 14,285). After revert, a "clean" v2 was attempted — also regressed (+6,822 CE, 14,810 pass). Both reverted.

**Root cause (technical)**: Post-hoc repair passes (walk instruction stream, splice in coercions) are inherently fragile. They lack semantic context, backward walks misidentify producers, and splice shifts indices. The approach is architecturally wrong — type mismatches must be fixed at generation time in codegen, not retroactively.

**Root cause (process)**:
- Dev ran "scoped tests" that passed but didn't run equivalence tests or full test262 before signaling completion
- Tech lead skipped post-merge equivalence tests (step 8 of pre-merge checklist) on the first merge
- The second attempt (v2) was cherry-picked to bypass ff-only, violating the merge protocol
- No architect reviewed the approach before implementation — a dev was assigned an architect-level design problem

**Impact**: ~2 hours of sprint time lost to merging, diagnosing, reverting, re-running test262 × 2.

**Action items**:
- A1: Add rule to developer.md: equivalence tests are mandatory before signaling completion, not optional
- A2: Add rule to developer.md: issues touching core codegen (expressions.ts, statements.ts, index.ts, type-coercion.ts) require full equivalence test pass
- A3: Add rule to pre-merge checklist: tech lead MUST run equivalence tests before broadcasting success — no exceptions
- A4: Tag #822 as `needs-architect` — no dev should attempt without an implementation spec

### Incident 2: dev-2 ignored rebase requests, signaled completion prematurely

**What happened**: dev-2 repeatedly signaled completion for #847, marked the task done, and moved to new tasks without rebasing onto main. Tech lead sent multiple rebase requests that went unprocessed.

**Root cause**: The developer.md "On completion" section says to mark task as `completed` and pick up the next task. There's no gate that says "wait for tech lead to confirm merge before claiming next task." The agent optimizes for throughput by moving forward, treating "code done" as "task done."

**Also**: Agents go idle before processing follow-up messages. Once they've signaled completion and moved on, rebase requests for the old task become low priority.

**Impact**: Tech lead had to chase dev-2 for rebases, ff-only merge failed multiple times.

**Action items**:
- A5: Redefine "completed" in developer.md: task is completed only when tech lead confirms the merge, not when code is done
- A6: Add to developer.md: after signaling completion, agent MUST stay responsive to rebase/fix requests for the signaled task until tech lead confirms merge — do NOT claim a new task until the previous one is merged or explicitly released by tech lead

### Incident 3: Tech lead skipped post-merge issue completion

**What happened**: After every merge, the tech lead should move issue files to done/, update the dependency graph, check for unblocked issues, and update the sprint doc. None of this happened until a batch cleanup at sprint end.

**Root cause**: The post-merge steps (steps 10-14) were added to the pre-merge checklist mid-sprint. Before that, there was no checklist reminder. Even after adding them, the pressure to merge the next branch meant they got skipped.

**Impact**: Dependency graph went stale, which directly caused Incident 4.

**Action items**:
- A7: These steps are already in pre-merge-checklist.md (steps 10-14) — the fix is enforcement, not documentation. Tech lead should treat steps 10-14 as blocking before dispatching the next task.

### Incident 4: 3-4 issues dispatched that were already fixed

**What happened**: #824 (compilation timeouts — system load, not a bug), #857 (fixed by #827), #850 (fixed by #866), and partially #825 (mostly fixed by #852) were dispatched to agents. All turned out to be already resolved.

**Root cause**: The dependency graph wasn't updated after prior sprint completions. Issues from the previous error analysis (#618-#634 era) were still listed as open when their root causes had been addressed by other fixes.

**Impact**: ~1 hour of agent time wasted on investigation + closure paperwork for 3-4 non-issues.

**Action items**:
- A8: Add to session-start-checklist.md: before dispatching, run a quick smoke test on each candidate issue's sample test cases to verify the failure still reproduces. If it passes, close the issue immediately.
- A9: PO should re-validate top-of-backlog issues against current main at sprint planning time

### Incident 5: Doc commits between merges caused rebase churn

**What happened**: Tech lead committed documentation changes (issue file updates, checklist edits) to main between agent merges. Each doc commit forced agents to rebase again, even though the doc changes had no code conflicts.

**Root cause**: The tech lead was working on main while agents were preparing branches for merge. Any commit to main — even docs-only — invalidates the ff-only condition.

**Impact**: Minor — agents rebased successfully each time. But it added unnecessary friction and time.

**Action items**:
- A10: Add to CLAUDE.md workflow section: batch all doc/plan commits on main AFTER all pending agent merges are complete, not between them. Or: do doc edits on a scratch branch and merge last.

### Incident 6: Agents rebased onto origin/main instead of local main

**What happened**: dev-1 rebased onto `origin/main` (stale remote, 29 commits behind) instead of local `main`. The worktree's `main` ref resolved to the wrong target.

**Root cause**: Worktrees created from local main track the local ref, but `git fetch origin main && git rebase main` in the developer.md instructions could resolve `main` to the remote tracking branch in some worktree configurations. The `git fetch` step is misleading when we haven't pushed.

**Impact**: Branch was based on stale main → ff-only failed → required re-rebase.

**Action items**:
- A11: Update developer.md rebase instructions: remove `git fetch origin main`. Replace with just `git rebase main` (local main is always authoritative during a session since we don't push mid-sprint)

### Incident 7: test262 OOM from concurrent agent + test runs

**What happened**: Running test262 with multiple forks while dev agents were still active caused OOM conditions.

**Root cause**: test262 runner defaults to 3 workers. With 3 dev agents (~2GB each) + system overhead, there isn't enough RAM for a multi-fork test262 run.

**Impact**: Partial/invalid test results, requiring re-runs after shutting down agents.

**Action items**:
- A12: Already mitigated: dev agents shut down before final test262 run. Add to session-start-checklist: "shut down all dev agents before running final test262 with multiple forks"

## Process observations

### What the checklists caught
- Pre-commit checklist: "check for accidental deletions" — would have caught #822 stale deletions IF followed
- Pre-merge checklist: ff-only gate prevented silent regressions on 5 merges
- Pre-completion checklist: final rebase check added mid-sprint, immediately useful

### What the checklists missed
- No checklist step says "run equivalence tests before signaling completion" — only "after rebase" in the test sequence, and it's treated as skippable
- No checklist step gates "don't claim new task until previous merge is confirmed"
- No validation that the issue being dispatched still reproduces

### Agent behavior patterns
- Agents treat task completion as "code done" not "merged to main" — this is the #1 source of friction
- Agents are optimized for throughput (claim next task ASAP) but the bottleneck is the merge queue
- Agents lose context of earlier messages after long operations — rebase requests sent during testing get ignored
- Scoped test validation is insufficient for core codegen changes — false confidence from passing narrow tests

## Action items summary

| # | Change | File | Priority |
|---|--------|------|----------|
| A1 | Equivalence tests mandatory before signaling completion | developer.md | HIGH |
| A2 | Core codegen changes require full equivalence pass | developer.md | HIGH |
| A3 | Tech lead MUST run equivalence tests post-merge — no exceptions | pre-merge-checklist.md | HIGH |
| A4 | #822 tagged needs-architect — no dev attempt without impl spec | plan/issues/ready/822.md | HIGH |
| A5 | "Completed" = merged, not code-done | developer.md | HIGH |
| A6 | Stay responsive to old task until merge confirmed | developer.md | HIGH |
| A7 | Enforce post-merge issue completion (already documented) | (enforcement) | MEDIUM |
| A8 | Smoke-test candidate issues before dispatch | session-start-checklist.md | MEDIUM |
| A9 | PO re-validates top issues at sprint planning | (PO process) | MEDIUM |
| A10 | Batch doc commits after all agent merges | CLAUDE.md | LOW |
| A11 | Remove `git fetch origin main` from rebase instructions | developer.md | HIGH |
| A12 | Shut down agents before final test262 | session-start-checklist.md | LOW |

## Proposed file edits

### developer.md — "On completion" section rewrite

**Current**:
```
### On completion
1. Mark your current task as `completed` via `TaskUpdate`
2. Check `TaskList` for the next unowned, unblocked task
3. If one exists: claim it...
4. If none available: message tech lead...
```

**Proposed**:
```
### On completion
1. **Before signaling**: run equivalence tests (`npm test -- tests/equivalence.test.ts`). If touching core codegen (expressions.ts, statements.ts, index.ts, type-coercion.ts), this is MANDATORY — do not skip.
2. Signal to tech lead: `"Completed #N (commit <hash>). Branch rebased, equivalence tests pass, ready for ff-only merge."`
3. **Wait for tech lead to confirm merge.** Stay responsive — if tech lead asks for rebase or fixes, handle them immediately. Do NOT claim a new task yet.
4. Once tech lead confirms merge (or explicitly releases you): mark task as `completed`, check TaskList for next task.
```

### developer.md — rebase instructions

**Current**: `git fetch origin main && git rebase main`
**Proposed**: `git rebase main` (remove the fetch — local main is authoritative during sessions)

### session-start-checklist.md — add issue validation step

Add: "Before dispatching an issue, verify the failure still reproduces by compiling one of the sample test cases from the issue description against current main. If it passes, close the issue."

### CLAUDE.md — add doc commit batching note

Add to Team & Workflow section: "Batch doc/plan commits on main AFTER all pending agent merges, not between them. Doc commits between merges force unnecessary agent rebases."
