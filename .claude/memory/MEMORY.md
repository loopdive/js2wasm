# ts2wasm Project Memory

## CRITICAL RULES (check every time)
- **NEVER delete worktrees without checking diffs first.** Run `git -C <wt> diff --stat` for EACH one, show to user, ask before deleting. Violated twice — no more.
- **NEVER work on agent branches/worktrees.** Always verify `pwd` is `/workspace` and branch is `main` before edits/commits.
- **NEVER kill running tests without asking.**

## Memory Index
- [user_role.md](user_role.md) — User profile: project lead, challenges assumptions, thinks in compilation strategies
- [project_team_setup.md](project_team_setup.md) — Agent team config, roles, sprint workflow, merge lessons
- [feedback_dev_limit.md](feedback_dev_limit.md) — Max 4 developer agents concurrently during sprints
- [feedback_usage_limit.md](feedback_usage_limit.md) — Don't dispatch new dev agents when usage is above 90%

- [feedback_issue_completion.md](feedback_issue_completion.md) — Issue completion procedure: move to done/, add frontmatter, write implementation summary, update log, unblock dependents
- [feedback_dev_agents_worktree.md](feedback_dev_agents_worktree.md) — Dev agents must always use worktree isolation, never work on main directly
- [feedback_document_findings.md](feedback_document_findings.md) — Always document agent findings in issue files before moving to done/backlog
- [feedback_ask_role.md](feedback_ask_role.md) — Ask at conversation start whether to act as Tech Team Lead or Product Owner

- [feedback_serialize_cherry_picks.md](feedback_serialize_cherry_picks.md) — Wait for all agents to finish before cherry-picking to main; serialize git ops
- [reference_error_analysis.md](reference_error_analysis.md) — Test262 error analysis procedure: run suite, classify patterns, deep-dive large buckets, split mega-issues
- [feedback_no_adhoc_scripts.md](feedback_no_adhoc_scripts.md) — Always use existing project scripts, never ad-hoc Python for report generation
- [feedback_test262_skip_issues.md](feedback_test262_skip_issues.md) — Every test262 skip filter must have a corresponding issue
- [feedback_never_delete_runs.md](feedback_never_delete_runs.md) — Never delete test262 run data from benchmarks/results/runs/
- [feedback_nothing_impossible.md](feedback_nothing_impossible.md) — Don't label features "impossible" — find the compilation strategy
- [feedback_po_boundary.md](feedback_po_boundary.md) — PO only writes to plan/ — never edit src/, tests/, scripts/
- [feedback_test262_recheck.md](feedback_test262_recheck.md) — Default to --recheck for test262 runs, use npm test for vitest
- [feedback_ask_before_killing_tests.md](feedback_ask_before_killing_tests.md) — Never kill running tests without asking user first
- [feedback_always_cd_workspace.md](feedback_always_cd_workspace.md) — Always cd /workspace before git commands on main
- [feedback_never_delete_test_data.md](feedback_never_delete_test_data.md) — Always ask before deleting/clearing test262 cache, results, or any test data
- [feedback_test262_worktree.md](feedback_test262_worktree.md) — Run test262 in a worktree, not main wc — avoids stash conflicts with cherry-picks
- [feedback_check_before_cleanup.md](feedback_check_before_cleanup.md) — Always check worktree diffs before removing — uncommitted work can be lost
- [feedback_stay_on_main.md](feedback_stay_on_main.md) — Tech lead works only on main wc, never on agent branches/worktrees

- [project_next_session.md](project_next_session.md) — Next session: resume test262 run, handle hanging tests, current state

Most project context lives in `/workspace/CLAUDE.md`.
