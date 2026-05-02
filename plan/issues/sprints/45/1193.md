---
id: 1193
title: "tooling: ci-status-watcher.sh hook doesn't push notifications to dev agents (uses gh @me which resolves to human, not agent)"
status: done
created: 2026-04-27
updated: 2026-04-28
completed: 2026-04-28
priority: medium
feasibility: easy
reasoning_effort: low
task_type: tooling
area: infrastructure
goal: compiler-architecture
es_edition: n/a
related: []
origin: surfaced 2026-04-27 — dev agents (this session) noticed they were learning about CI completion via team-lead SendMessage rather than via the FileChanged hook. Investigation showed the hook authors-by-GH-token match is wrong for the multi-agent / single-token setup.
---
# #1193 — `ci-status-watcher.sh` hook doesn't reach dev agents

## Problem

`/workspace/.claude/settings.json` registers a `FileChanged` hook on
`.claude/ci-status/`:

```json
"FileChanged": [
  { "matcher": ".claude/ci-status/", "hooks": [
      { "command": ".claude/hooks/ci-status-watcher.sh" }
  ]}
]
```

The hook script is supposed to inject a system reminder into the dev's
agent stream when the dev's own PR's CI status posts. But in this
session, dev agents (#1185, #1186, #1177 PRs) consistently learned
about CI status via team-lead `SendMessage`, NOT via the hook.

## Root cause

`ci-status-watcher.sh` matches PR ownership via:

```bash
gh pr list --author @me --state open --json number
```

`@me` resolves to the GitHub token holder. In a multi-agent / single-token
setup (one human's token shared across agents), every PR is
GH-authored by the same human — so `@me` matches ALL open PRs, but
the dev agent that did the WORK isn't necessarily the human running
the orchestrator. The hook fires correctly on the orchestrator's
session (whose identity matches `@me`) but not on the dev agent's
session.

Effect: dev agents end up polling via background bash loops
(`until [ -f .../pr-N.json ]; do sleep 30; done`), which works but is
30s slower than push and consumes a small steady token cost during
long PR queues.

## Fix options

### A. Match by branch name, not GH author (recommended)

The dev agent owns a specific worktree with a specific branch. When
the hook fires for `pr-N.json`, parse `head_branch` from the JSON
and match against the agent's current worktree branch (or against a
session-registered branch list).

The dev agent registers its branch on PR-create:

```bash
echo "$(git rev-parse --abbrev-ref HEAD)" >> ~/.claude/agent-branches/$AGENT_ID.txt
```

Hook reads:
```bash
HEAD_BRANCH=$(jq -r .head_branch < "$FILE")
if grep -qx "$HEAD_BRANCH" ~/.claude/agent-branches/*.txt; then
  # inject reminder for the matching agent's session
fi
```

### B. Fire for ALL CI status changes, let the agent filter

Drop the ownership match entirely; emit `additionalContext` for every
change. The agent's existing logic ("is this a PR I care about?") can
filter. Slightly noisier but completely avoids the identity mismatch.

### C. Use a separate notification channel per-agent

Instead of a global FileChanged hook, dev agents register a watcher
when they open a PR. The watcher writes to the agent's own task-
notification file. This is what my session is doing manually with
`until [ -f ... ]` loops; it could be productized.

I recommend **A** — minimal change, preserves the "fire only on owned
PRs" intent, and works for the multi-agent / single-token case.

## Acceptance criteria

1. After fix, dev agents that open a PR receive a system-reminder
   injection within 5 seconds of the CI status JSON appearing.
2. Manual polling loops in dev sessions (the `until [ -f ...]`
   pattern) can be removed.
3. The orchestrator continues to receive notifications for ALL PRs
   so the human-facing view is unchanged.

## Out of scope

- Changing the CI status feed itself (`ci.yml` /
  `ci-status-feed.yml`).
- Multi-token setups (each agent has its own GH PAT) — that would
  fix the `@me` issue naturally but adds token-management
  complexity.
- Migrating off FileChanged to a different push mechanism (e.g.
  WebSocket); current architecture is fine if the matching is fixed.

## Notes

The hook script's existing comment block already documents the
intent ("inject a system reminder when a file matching the current
dev's own PR is created or updated"). The matching mechanism just
needs to use branch-name instead of GH-author for the multi-agent
case.

This issue is filed mid-session by the dev agent that observed the
gap. Effort: trivial (~10 lines in the bash hook + a small dev-
side branch-registration helper). Time-box: 30 minutes.
