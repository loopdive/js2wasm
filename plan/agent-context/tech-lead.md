---
agent: tech-lead
session_end: 2026-04-11-fresh-team-restart
next_session_entry_point: CLAUDE_CODE_TEAM_NAME=sprint-40-fresh claude — fresh session, fresh team, read this file + plan/sprints/sprint-40.md first thing
last_handoff_reason: "third team restart of the day — inbox delivery to tech-lead session broken for hours (285 messages backlogged in ~/.claude/teams/sprint-40/inboxes/team-lead.json that were never auto-delivered as turns). Sprint 40 goal reached; fresh team starts Sprint 41 cleanly."
---

## CURRENT STATE (as of 2026-04-11 end of Sprint 40)

### Baseline
- **21,750 pass / 43,164 total = 50.39%** (projected after PR #87 merge, refresh commit pending)
- Last-committed baseline on origin/main: 21,580 (50.00%)
- **Sprint 40's headline goal (past 50%) REACHED**

### What shipped today (2026-04-11)
Sprint 40 second-day session merged ~13 PRs net +2,851 pass:
- Morning wave: #43, #64, #68, #70, #71, #73 (+479)
- Afternoon wave: #77, #78, #79, #80, #81 (+672)
- Evening wave: #82, #84, #85, #86, #87 (+1,700 across TypedArray, DisposableStack, getter-callback, Symbol.dispose, fn-name-cover)
- Plus ci-status-feed auto-commits (~15 small [skip ci] commits)

### Closed PRs (do NOT re-open)
- #72 #1026 first attempt — catastrophic −18,504, over-broad __get_builtin rewrite
- #75 #1025 first attempt — net −114 blanket ref.is_null replacement
- #76 #1017 Pattern 3 — orphaned +2, closed
- #65 #1017 P3 yield* — marginal +2, closed
- #83 #1026 second attempt — 221 [object WebAssembly.Exception] CEs, over-broad intercept (same shape as #72); needs NARROWER retry

### In-flight worktrees (preserve, these may contain uncommitted WIP)
```
.claude/worktrees/issue-1017-class-name-binding/        2 commits
.claude/worktrees/issue-1017-pattern3/                  3 commits
.claude/worktrees/issue-1024-destr-rest-holes-null/     3 commits (PR #74 closed, stale)
.claude/worktrees/issue-1025/                           3 commits (dev-1030's #1025 BindingElement audit, in progress)
.claude/worktrees/issue-1026-builtin-prototype/         1 commit (stale)
.claude/worktrees/issue-1026-proto-globals-v2/          3 commits (dev-1038's narrower retry for #1026 — needs PR or rework)
.claude/worktrees/issue-1037-symbol-dispose/            2 commits (merged as PR #86)
.claude/worktrees/issue-1049-dstr-fn-name-cover/        1 commit (merged as PR #87)
.claude/worktrees/issue-1050-annexb-extension-suppress/ 1 commit (dev-990's #1050 WIP, not yet in PR)
.claude/worktrees/issue-1051-private-static-methods/    1 commit (dev-1036's #1051 WIP, not yet in PR)
```

### Open PRs waiting for merge/review (next session)
- None currently (all merged or closed). But #1025 #1026 #1050 #1051 and others are WIP in worktrees and will push soon.

## ISSUES STATE

### Active tasks (work someone has in flight, do NOT reassign without checking)
- **#1025** BindingElement audit (dev-1030, worktree `issue-1025`) — 3 commits, still progressing
- **#1026** String/Number/Boolean.prototype globals (dev-1038 was on it, PR #83 closed. v2 worktree has 3 commits) — may need explicit re-dispatch with NARROWER guard (only match when `propAccess.expression.text === "String"|"Number"|"Boolean"` AND `propAccess.name.text === "prototype"`)
- **#1050** annexB extension-suppression (dev-990, worktree `issue-1050-annexb-extension-suppress`) — 1 commit, needs push
- **#1051** Private static class methods (dev-1036, worktree `issue-1051-private-static-methods`) — 1 commit, needs push

### #1047 — reassigned to architect, DO NOT dispatch as dev task
Issue is MISNAMED. Actual root cause per dev-990's investigation: **public instance fields** leak via `emitLazyProtoGet` in `src/codegen/expressions/extern.ts:125-181` materializing `C.prototype` as a full instance struct, then `_wrapForHost` (`src/runtime.ts:587`) Proxy enumerates every struct field. arch-npm-stress wrote the implementation spec in commit `d3807e0b` (Option B: runtime method-name allowlist in _wrapForHost). Feasibility: hard. Ready for dev pickup AFTER reading the arch spec.

### #832 — TypeScript 6.x upgrade — CLOSED / DEFERRED
dev-990 attempted and found **81 equivalence regressions** across async-function, async-iteration, promise-chains, for-await-of, tdz, arrow-call-apply, null-deref. Net-negative vs +82 unicode gain and hits exactly the areas Sprint 40 fixed. Closed in TaskList #36 with note "re-evaluate at TS 7 migration (#1029)".

### Harvester top picks still pending (Sprint 41/42 queue)
Filed earlier today by `harvester-post-sprint-40-merge` in commit `13c3d5cc`:
- **#1047** (246, reassigned to architect — see above)
- **#1049** (176) — MERGED via PR #87 ✓
- **#1053** (133) arguments.length trailing-comma — dev-1038 assigned via SendMessage but may not have started
- **#1054** (122) derived class indirect-eval supercall
- **#1050** (110) — dev-990's WIP, needs push
- **#1056** (89) DataView set methods
- **#1051** (88) — dev-1036's WIP, needs push
- **#1052** (80) Array destr with overridden Symbol.iterator
- **#1055** (77) RegExp pattern modifiers
- **#1048** (75) async-gen dstr illegal cast
- **#1057** (68) String.prototype.split constructor

## LESSONS FROM TODAY (applied to fresh team)

1. **Inbox delivery to tech-lead can break silently.** 285 messages backlogged in `~/.claude/teams/sprint-40/inboxes/team-lead.json` while my conversation thought the team was idle. Detection: periodically `python3 -c "import json; print(len(json.load(open('~/.claude/teams/<team>/inboxes/team-lead.json'))))"` and if the count jumps without corresponding conversation turns, delivery is broken.

2. **TaskList has per-agent namespace splits.** When devs see task IDs different from tech-lead's, two separate stores are running. Fallback: SendMessage is authoritative for dispatch; TaskList is an index, not a channel.

3. **"Devs idle" ≠ stuck.** The between-turn idle state looks identical to "hung" from tech-lead's view. Before worrying, check `gh pr list --state open` and recent commits — they may be shipping continuously.

4. **Dev self-merge skill exists** (`.claude/skills/dev-self-merge.md`). Tech-lead merges only for ambiguous cases; routine clean merges are self-service.

5. **Option B CI Status Feed** (`.github/workflows/ci-status-feed.yml` → `.claude/ci-status/pr-<N>.json` → dev FileChanged hook) is working. Devs don't need to download artifacts manually.

6. **"Pushed = done, claim next NOW"** is the dev protocol. Do NOT wait for merge confirmations. Documented in CLAUDE.md.

## FRESH TEAM RESTART PROTOCOL

1. Create new team: `TeamCreate(team_name="sprint-40-fresh", description="Fresh restart after Sprint 40 goal reached; broken inbox delivery on original sprint-40 team")`
2. User shuts down old dev tmux panes (or sends shutdown_requests to all)
3. Spawn 3-4 fresh devs via Agent+team_name, each with direct task assignment in prompt (not relying on TaskList)
4. Top priority assignments:
   - **dev-1030-fresh** → #1053 (arguments.length, 133 FAIL) — narrow codegen bug
   - **dev-1031-fresh** → #1054 (derived class indirect-eval supercall, 122 FAIL) — narrow early-error gap
   - **dev-1032-fresh** → #1056 (DataView set methods, 89 FAIL) — straightforward missing built-ins
   - **dev-1033-fresh** → #1026 narrower retry (String/Number/Boolean.prototype globals) — incorporate the lesson from PR #83's 221-CE catastrophe
5. Delete old team: `TeamDelete(team_name="sprint-40")` AFTER confirming old dev processes are terminated

### Commands for the fresh tech-lead session
```
pwd && git branch --show-current
git log --oneline origin/main -8
gh pr list --state open
cat plan/agent-context/tech-lead.md
ls .claude/worktrees/
```

Then TeamCreate the fresh team and dispatch.

## Things that are DONE (do NOT redo)

- Sprint 40 goal crossed 50% ✓
- Option B CI Status Feed workflow + FileChanged hook ✓
- `/dev-self-merge` skill written ✓
- 11 harvester issues filed (#1047–#1057) ✓
- arch-npm-stress implementation spec for #1047 ✓
- Sprint 41 stress test issues #1031–#1034 + #1058 TypeScript compiler + #1059 parallel tsc ✓
- WASI hello-fs issue #1035 ✓
- feedback memory rules (`_compact_before_sprint`, `_context_discipline`, `_team_comm_channels`, `_token_budget_guardrails`, `_diary_and_sprints_before_compact`, `_dev_self_serve_tasklist`, `_tasklist_sync_unreliable`) ✓
- 5 dead VOID_RESULT comparisons in `src/codegen/expressions/calls.ts` fixed ✓
- `.tmp/` scratch convention + hook regex fix ✓

The fresh session starts Sprint 41 work. See plan/sprints/sprint-41.md.
