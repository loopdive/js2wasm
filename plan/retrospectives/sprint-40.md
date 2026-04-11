---
sprint: Sprint-40
status: interim
session_end: 2026-04-11
---

# Sprint 40 Retrospective — INTERIM (sprint still active)

This is an interim retrospective captured 2026-04-11 end-of-day. Sprint 40 has NOT officially closed. The final retro will be written when the sprint closes (target: 50% conformance + in-flight PRs resolved).

## Numbers

| Metric | Sprint start | Session start | Session end |
|--------|--------------|---------------|-------------|
| test262 pass | 18,899 | 20,711 | **21,190** |
| pass rate | 43.8% | 47.98% | **49.09%** |
| Gap to 50% | — | 871 | 392 |

**Net sprint-to-date delta: +2,291 pass / +5.3 percentage points.** Sprint goal (past 50%) not yet met.

## What shipped

See `plan/sprints/sprint-40.md` Results section for the full merge list. Highlights from the 2026-04-11 session: PRs #43, #64, #68, #70, #71, #73 merged (+479 net). Earlier in the sprint: #1014 async generators (+1,489), #1018 GOPD built-ins (PR #66), #1021 destructuring defaults, #1017 patterns 1+2.

## What went well

1. **Big merge waves are feasible.** Six PRs in a single session, all net positive, crossing 49% for the first time.
2. **False-positive discipline held.** Dev-929's catch of the String.prototype coincidental-pass pattern saved at least one revert cycle. The `feedback_regression_analysis.md` rule is paying off.
3. **CI autopilot closed.** PR #70 ended the last manual step in the sharded baseline → Pages deploy pipeline.
4. **Self-serve TaskList worked.** Devs started claiming the next unowned task from TaskList after merges without re-dispatch.
5. **Scratch cleanup is permanent.** `.tmp/` + gitignore patterns stop the `git status` bleeding for good.

## What went badly

1. **Two catastrophic PRs landed through CI and only got caught at merge triage.** PR #72 (−18,504) and PR #75 (−114) were both "blanket replacement" fixes that over-broad their scope. Sharded CI marked them as "test262 Sharded: failure" due to regressions, but I still had to manually triage and close. Better would have been to sample the regression list on the PR page and close before opening the merge window.
2. **OOM mid-session.** ~30 tmux panes + 13 concurrent vitest runs + a stuck `/tmp/probe-998.mts` from dev-998 killed the tech-lead process. Cost ~20 min of recovery (identify orphan processes, broadcast "one vitest per dev" rule, resume session).
3. **Token budget burn — 43% weekly in one session.** Long continuous context across triage + merge + planning + UI + infra in a single conversation. Root causes: repeated state re-checks (git status, git log, free -m), large tool outputs (full run logs, large diffs), leaked scratch noise in every `git status`, inherited compaction summary from the prior resume.
4. **Stale issues waste dispatch cycles.** #984 turned out to be already fixed; dev-1018 spent a full dispatch verifying it. The "smoke-test before dispatch" rule exists but wasn't enforced.
5. **#74 couldn't land.** dev-1016's destructuring rest/holes PR became stale during the merge wave. Rebased twice, still not mergeable by end of session.

## Process improvements applied

1. **New memory rules saved (will persist to future sessions):**
   - `feedback_compact_before_sprint.md` — `/compact` at sprint boundaries
   - `feedback_context_discipline.md` — stop re-checking state, split planning/execution, write tech-lead handoffs to `plan/agent-context/tech-lead.md` instead of --resume
   - `feedback_team_comm_channels.md` — dev status via TaskUpdate (not verbose SendMessage), shutdown handoffs via `plan/agent-context/{name}.md`
   - `feedback_token_budget_guardrails.md` — warn at 25% weekly, force break at 40%, hard stop at 50%
   - `feedback_dev_self_serve_tasklist.md` — devs claim next task themselves
   - `feedback_diary_and_sprints_before_compact.md` — update diary and sprint doc BEFORE `/compact`

2. **Repo hygiene:**
   - `.tmp/` convention for dev scratch (gitignored, documented in CLAUDE.md)
   - Root-level scratch patterns added to `.gitignore` as a safety net
   - 49 leaked scratch files moved into `.tmp/`

3. **CI:**
   - PR #70 auto-dispatches Pages deploy after sharded baseline refresh

## What's NOT yet addressed

- **Narrower PR scope rule** for `ref.is_null` / identifier-path replacements — PR #75 burned cycles because the audit was too broad. Should be a checklist item for any codegen-wide refactor PR.
- **Regression sampling before merge** when delta > 100 pass — should be standard practice, not ad-hoc.
- **Smoke-test before dispatch** — existing rule not enforced this sprint; still blew a dispatch on #984.
- **#990 early-error progress check** — dev-929 was assigned but session ended before I verified status.

## Sprint close criteria (remaining)

1. Cross 50% conformance (+392 pass). **#1030 Array long tail (372 tests) is the single highest-leverage move** — potential +200 to +350 alone.
2. PR #74 (#1024) and PR #59 (#1016) either merged or closed.
3. dev-1017 / dev-1018 shutdown scale-down (8 → 6 devs) completed.
4. Final retrospective pass that amends this file with sprint-close numbers + tag `sprint/40`.

## Entry points for the next session

```
Read plan/agent-context/tech-lead.md                        # tech lead handoff
Read plan/sprints/sprint-40.md                              # sprint doc w/ interim results
Read plan/retrospectives/sprint-40.md                       # this file
Bash git fetch && git log --oneline origin/main -10          # what landed overnight
Bash gh pr list --limit 10                                    # PR queue
```

Then file **#1030** dispatch (highest priority) and check dev-929 progress on #990.
