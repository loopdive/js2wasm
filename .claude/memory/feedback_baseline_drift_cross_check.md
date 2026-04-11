---
name: Cross-check regression clusters against other open PRs before treating as real
description: When sampling CI regressions, compare against other unrelated open PRs from the same baseline — identical clusters are drift artifacts, not real regressions
type: feedback
originSessionId: fad84284-8590-4992-b3a1-47149eeef103
---
When a PR's CI reports regressions, before assuming they're caused by the PR:

1. Check other recent PR CI feeds in `.claude/ci-status/pr-*.json` and the
   merged-report artifacts from other open branches that built against the
   same baseline.
2. If the same test names appear as regressions in **unrelated** PRs whose
   diffs don't touch that area (e.g. DataView detached-buffer regressions
   showing up in a PR that only edits eval codegen), those are almost
   certainly **baseline drift**, not real regressions.
3. Real regressions cluster by diff area: a DataView PR causes DataView
   regressions; an eval PR causes eval regressions. Cross-domain ghost
   clusters are noise from when baseline was captured vs when PR branches
   re-ran.
4. Before self-merge, run a local scoped compile+run on the regressed tests
   from your worktree. If they pass locally, the "regression" is drift and
   can be discounted from the self-merge gate.

**Why:** 2026-04-11 PR #107 (#1064 DataView) showed 4 DataView detached-buffer
tests as regressions in CI, but all 4 passed when compiled+run locally from
the same worktree. Same tests have been flipping on other unrelated PRs
(#100, #103, #104) — it's stale baseline noise. Team-lead called out the
pattern explicitly after dev-1047 saw the same DataView cluster on PR #100.

**How to apply:** when self-merge gate shows regressions, don't just count
them blindly against the ratio. Sample them locally; if they pass, they're
drift and the PR is safe to merge. Mention the cross-check in the self-merge
report so the team-lead can audit the reasoning.
