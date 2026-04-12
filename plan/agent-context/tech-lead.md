---
agent: tech-lead
session_end: 2026-04-12-sprint-40-complete
next_session_entry_point: Start fresh session, fresh team. Read this file + plan/sprints/sprint-41.md first.
last_handoff_reason: "Sprint 40 closed. Sprint 41+42 planned by PO. All PRs merged or deferred. CI baseline-drift crisis resolved. Team shut down cleanly."
---

## CURRENT STATE (as of 2026-04-12 end of Sprint 40)

### Baseline
- **22,185 pass / 43,171 total = 51.40%**
- Last baseline refresh: `59cee41a` on origin/main
- Sprint 40 started at 18,899 (43.80%), net +3,286 pass this sprint

### What shipped in the final session (2026-04-11/12)
24 PRs merged across two merge waves + a CI crisis investigation:
- Wave 1: #86 #88 #89 #90 #91 #92 #93 #94 #95 #98 #101 #103 #106
- Wave 2 (post-crisis): #105 #108 #109 #110 #111 #114 #116 #118
- CI hardening: #111 (#1082 net_per_test fix), #118 (#1084 fork-worker compileCount)
- Rescue: #114 (3-PR revert of #96/#100/#107 after baseline drift)
- Reapply: #116 (#107 DataView reapply, clean)

### CI baseline-drift incident (2026-04-11 19:00-21:00 UTC)
- Main's baseline silently dropped from 22,157 to 20,624 due to stale-baseline gate + fork-worker state interaction
- Investigation: artifact-diff bisect, 4 revert probes (PR #112-#114, #115), compile_ms histogram, fork-worker audit
- Root cause: 3-PR interaction (#96+#100+#107) under CI cgroup stack budget + fork-worker compileCount bypass
- Fix: PR #118 (RECREATE_INTERVAL 200→100, try/finally compileCount, explicit dispose)
- Rescue: PR #114 (3-PR revert) restored baseline to 22,157
- Walker-recursion hypothesis (PR #115) refuted empirically
- Full writeup: `plan/investigations/2026-04-11-baseline-regression-bisect.md`
- Reusable playbook: `plan/retrospectives/2026-04-11-ci-baseline-drift-investigation.md`

### Reverted work needing rework (Sprint 41)
- **#1053** (arguments.length argv extras) — cherry-pick onto current main caused 37k CE catastrophe due to semantic conflicts with #108/#110. Needs rework against current codebase, not just reapply.
- **#1057** (vec-struct constructor runtime half) — 9 LOC, interaction with #107 triggers stack overflow without fork-worker fix. Untested solo on fork-worker-fixed main. Low-risk but unvalidated.
- Both issues updated with "Status: Reverted" sections in their issue files.

### Open PRs
- **#102** (#1006 eval host import) — draft, blocked on #1073 scope-injection
- **#38** (MCP channel server) — old draft from March, not ours

### Sprint 41 plan (ready)
File: `plan/sprints/sprint-41.md`
- 15 issues, 3 phases, 100% pass-rate push
- Phase 1 quick wins: #1056, #997, #1057 reapply
- Phase 2 medium-effort: #1049, #1090, #1018, #1053 rework, #1054, #1091, #1051, #1052, #1055, #1092, #1024
- Phase 3 stretch: #1016, #1006+#1073, #990
- Projection: 52.7% conservative, 53.7% realistic, 54.6% optimistic

### Sprint 42 plan (ready)
File: `plan/sprints/sprint-42.md`
- Goal: lodash-es compiles and runs E2E in Wasm
- Critical enabler: #1074 (export default surfacing)
- Phases: enabler → lodash demo → Sprint 41 overflow → prettier follow-ups → CJS support → CI hardening

### Issues filed this session
#1066-#1093 (28 new issues):
- CI hardening: #1076-#1082, #1084-#1087
- Lodash chain: #1074, #1075
- Error analysis: #1088, #1089, #1090, #1091, #1092
- Spec conformance audit: #1093
- Eval: #1066, #1073
- UI: #1067 (dep graph web component)
- Prettier follow-ups: #1068-#1072
- Latent bugs: #1083 (double-compile), #1086 (dedup+memo bodyUsesArguments)

### Preserved drafts in worktrees (may still exist on disk)
- `.claude/worktrees/issue-1053-stack-depth-fix` — dev-1031's iterative bodyUsesArguments + walkInstructions drafts
- `.claude/worktrees/issue-1082-ci-feed-net-per-test` — dev-1047's fork-worker draft (now merged via #118)
- `origin/issue-1087-walk-instructions-iterative` — dev-1031's PR #115 branch (closed, retained)

### Memory rules added this session
- `feedback_baseline_drift_cross_check.md` — cross-check regressions across PRs
- `feedback_tasklist_sync_unreliable.md` — SendMessage as authoritative dispatch
- `feedback_spec_first_fixes.md` — always fetch ECMAScript spec before fixing test failures

### Skills added this session
- `.claude/skills/tech-lead-loop.md` — 5-phase sprint orchestration loop
- `.claude/skills/create-issue.md` — updated to require ECMAScript spec references

### Key lessons from this session
1. **Stale-baseline drift** is a first-class failure mode — PR CIs against frozen baselines systematically overestimate progress (~5x inflation observed)
2. **Fork-worker compileCount bypass** (error-path early return skipping counter) prevented RECREATE from firing under CI cgroup pressure
3. **Walker-recursion hypothesis was wrong** — always verify with empirical revert probes before shipping theoretical fixes
4. **72 issue files** now have ECMAScript spec references for future devs
5. **Sonnet tech-lead** viable for routine orchestration; escalate to Opus for crisis synthesis

## FRESH SESSION START PROTOCOL

1. Read this file
2. Read `plan/sprints/sprint-41.md`
3. `git log --oneline origin/main -10` to verify baseline
4. `gh pr list --state open` to check for stale PRs
5. Create fresh team: `TeamCreate(team_name="sprint-41")`
6. Tag sprint start: `git tag sprint-41/begin`
7. Spawn 3 devs + dispatch Phase 1 quick wins
8. Run `/tech-lead-loop` for continuous orchestration
