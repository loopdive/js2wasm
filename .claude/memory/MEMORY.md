# ts2wasm Project Memory

## CRITICAL RULES (check every time)
- **ALWAYS spawn agents as teammates** (TeamCreate + Agent with team_name), NOT bare subagents.
- **Max 3 dev agents + 1 PO.** Each dev ~2GB RSS. Always use bypassPermissions + worktree isolation.
- **BEFORE EVERY git add/commit**: run `pwd && git branch --show-current` to verify you're in `/workspace` on `main`. Agent worktrees change your cwd silently.
- **NEVER use `git add -A`** — it stages everything including worktree artifacts. Use `git add <specific files>` instead.
- **NEVER delete worktrees without checking diffs first.** Run `git -C <wt> diff --stat` for EACH one, show to user, ask before deleting.
- **NEVER work on agent branches/worktrees.** Always verify `pwd` is `/workspace` and branch is `main` before edits/commits.
- **NEVER kill running tests without asking.**

## Single source of truth
- Team setup, memory budget, spawn config, communication protocol: **`plan/method/team-setup.md`**
- Agent definitions: **`.claude/agents/{product-owner,developer,tester}.md`**
- Memory files below store only user prefs/feedback that don't belong in repo files.

## Memory Index

### User & project
- [user_role.md](user_role.md) — Project lead: challenges assumptions, thinks in compilation strategies
- [project_team_setup.md](project_team_setup.md) — All agents as teammates via TeamCreate; details in plan/method/team-setup.md
- [project_next_session.md](project_next_session.md) — Session state: 16,013 pass, honest baseline after exception tag fix

### Team & agents (rules not in plan/method/team-setup.md)
- [feedback_dev_limit.md](feedback_dev_limit.md) — Max 4 devs as teammates, test file naming, merge method
- [feedback_dev_agents_worktree.md](feedback_dev_agents_worktree.md) — ALL writing agents must use worktree isolation
- [feedback_serialize_cherry_picks.md](feedback_serialize_cherry_picks.md) — Wait for wave to finish, then batch merge (not cherry-pick)
- [feedback_always_cd_workspace.md](feedback_always_cd_workspace.md) — Git safety: cd /workspace, verify main, never work from agent worktrees
- [feedback_usage_limit.md](feedback_usage_limit.md) — Stop dispatching above 90% context usage
- [feedback_dont_ask_continue.md](feedback_dont_ask_continue.md) — Keep dispatching automatically, don't pause to ask
- [feedback_reduce_notification_noise.md](feedback_reduce_notification_noise.md) — Only msg team-lead for merges/blockers/decisions, use TaskUpdate otherwise
- [feedback_always_use_teammates.md](feedback_always_use_teammates.md) — Team: 4 devs + PO on demand, always as teammates via TeamCreate
- [feedback_work_planning.md](feedback_work_planning.md) — Pre-build task queue, any dev on any task, time-box, batch merges
- [feedback_ttl_runs_tests.md](feedback_ttl_runs_tests.md) — TTL runs tests serially in background, no tester teammate
- [feedback_bypass_permissions.md](feedback_bypass_permissions.md) — Always use bypassPermissions mode when spawning agents
- [feedback_dev_self_serve_tasklist.md](feedback_dev_self_serve_tasklist.md) — Devs claim next task from TaskList after merge; no re-dispatch
- [feedback_tasklist_always_populated.md](feedback_tasklist_always_populated.md) — Populate TaskList at sprint start AND whenever a new issue is added mid-sprint; empty queue = agents spin idle
- [feedback_compact_before_sprint.md](feedback_compact_before_sprint.md) — Run /compact at sprint boundaries to reset context and control token burn
- [feedback_context_discipline.md](feedback_context_discipline.md) — Don't re-check state; split planning/execution sessions; write handoffs to plan/agent-context/tech-lead.md
- [feedback_team_comm_channels.md](feedback_team_comm_channels.md) — Dev status via TaskUpdate not verbose SendMessage; shutdown handoffs via agent-context files
- [feedback_token_budget_guardrails.md](feedback_token_budget_guardrails.md) — Warn at 25% weekly budget, force break at 40%, hard stop at 50%
- [feedback_diary_and_sprints_before_compact.md](feedback_diary_and_sprints_before_compact.md) — Update plan/diary.md and plan/issues/sprints/N/sprint.md (+ retrospective) BEFORE /compact — never discard learnings with the conversation
- [feedback_tasklist_sync_unreliable.md](feedback_tasklist_sync_unreliable.md) — TaskList sync per-agent is unreliable; when devs report mismatched task IDs, fall back to SendMessage as authoritative dispatch
- [feedback_sendmessage_discipline.md](feedback_sendmessage_discipline.md) — SendMessage = blockers/decisions/completions only; status/idle/ack → TaskUpdate or silence

### Dispatch
- [feedback_dispatch_status.md](feedback_dispatch_status.md) — Update issue status to in-progress when dispatching an agent

### Issue management
- [feedback_issue_completion.md](feedback_issue_completion.md) — Completion procedure: move, frontmatter, summary, log, unblock
- [feedback_document_findings.md](feedback_document_findings.md) — Document agent findings in issue files before closing
- [feedback_update_backlog.md](feedback_update_backlog.md) — Always update backlog.md when creating/completing issues
- [feedback_po_boundary.md](feedback_po_boundary.md) — PO only writes to plan/

### Testing
- [feedback_test262_worktree.md](feedback_test262_worktree.md) — Test262 in worktree, not main wc
- [feedback_test262_recheck.md](feedback_test262_recheck.md) — Default --recheck for test262, npm test for vitest
- [feedback_test262_skip_issues.md](feedback_test262_skip_issues.md) — Every skip filter must have an issue
- [feedback_never_delete_test_data.md](feedback_never_delete_test_data.md) — Never delete test data/cache/runs without asking
- [feedback_ask_before_killing_tests.md](feedback_ask_before_killing_tests.md) — Never kill running tests without asking
- [feedback_baseline_drift_cross_check.md](feedback_baseline_drift_cross_check.md) — Cross-check CI regressions against other open PRs; sample locally — identical clusters across unrelated PRs are drift
- [reference_error_analysis.md](reference_error_analysis.md) — Test262 error analysis procedure

### Development methodology
- [feedback_spec_first_fixes.md](feedback_spec_first_fixes.md) — Always fetch the ECMAScript spec (tc39.es/ecma262) before fixing test failures; implement from fetched spec text, never from memory; cite spec section in commits

### Model usage
- [feedback_sonnet_for_sprint_loop.md](feedback_sonnet_for_sprint_loop.md) — Use Sonnet for routine sprint loop; Opus only for crisis/architecture

### General behavior
- [feedback_ask_role.md](feedback_ask_role.md) — Ask at conversation start: Tech Lead or Product Owner
- [feedback_ask_ralph_loop.md](feedback_ask_ralph_loop.md) — Ask if Ralph loop should be started for current goals
- [feedback_no_adhoc_scripts.md](feedback_no_adhoc_scripts.md) — Use existing scripts, never ad-hoc Python
- [feedback_nothing_impossible.md](feedback_nothing_impossible.md) — Don't label features impossible — find the compilation strategy
- [feedback_compile_away.md](feedback_compile_away.md) — Compile away, don't emulate — resolve JS semantics statically, zero runtime overhead
- [feedback_no_nuclear_option.md](feedback_no_nuclear_option.md) — Never take destructive shortcuts without consent
- [feedback_wait_for_answer.md](feedback_wait_for_answer.md) — Ask then STOP — never act on assumed "yes" in the same message
- [feedback_check_before_cleanup.md](feedback_check_before_cleanup.md) — Check worktree diffs before removing
- [feedback_refactoring_failures.md](feedback_refactoring_failures.md) — After refactoring: check missing imports first, not circular deps
- [feedback_sprint_tags.md](feedback_sprint_tags.md) — Tag sprint-N/begin at start, sprint/N at end
- [feedback_no_stash_before_merge.md](feedback_no_stash_before_merge.md) — Never stash before merge, commit first
- [feedback_regression_analysis.md](feedback_regression_analysis.md) — Regressions may be false-positive exposure, not real regressions

Most project context lives in `/workspace/CLAUDE.md`.
