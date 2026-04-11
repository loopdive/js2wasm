# CI Status Feed

This directory receives per-PR test262 CI completion signals from the **CI Status Feed** GitHub Actions workflow (`.github/workflows/ci-status-feed.yml`).

## How it works

1. Dev pushes a branch and opens a PR (`gh pr create`), then **immediately claims the next task** from TaskList per the "pushed = done" protocol (see CLAUDE.md "Agent work dispatch").

2. GitHub Actions runs the sharded test262 workflow against the PR branch.

3. When the sharded run completes, **CI Status Feed** fires on the `workflow_run` event:
   - Downloads the merged-report artifact from the triggering run
   - Computes pass/fail/delta/regressions against the current `main` baseline
   - Writes `pr-{N}.json` in this directory
   - Commits with `[skip ci]` and pushes to main

4. Every dev's `FileChanged` hook (`.claude/hooks/ci-status-watcher.sh`) fires on the new file. The hook checks if the PR number matches one the dev authored:
   - **Not mine:** silent no-op
   - **Mine + success + positive delta:** reminder "CI passed, tech lead will merge, stay on current task"
   - **Mine + success but negative delta:** reminder "sample regressions and decide"
   - **Mine + failure:** reminder "context-switch back and fix"

5. The reminder is injected as `hookSpecificOutput.additionalContext` on the dev's next turn, giving them first-class CI awareness without needing SendMessage from the tech lead.

## File format

```json
{
  "pr": 74,
  "conclusion": "success",
  "head_branch": "issue-1024-destr-rest-holes-null",
  "head_sha": "b31d3ee1...",
  "run_url": "https://github.com/loopdive/js2wasm/actions/runs/...",
  "timestamp": "2026-04-11T12:03:13Z",
  "pass": 21190,
  "fail": 19199,
  "compile_error": 1325,
  "delta": 0,
  "regressions": 0,
  "improvements": 0
}
```

## Why this exists

When the team-lead ↔ dev SendMessage channel breaks (OOM, session restart, etc.), devs previously hung waiting for a "merged, do next task" message that never arrived. This pipeline gives devs an authoritative CI signal directly from the repo, decoupled from the comms layer. Belt-and-suspenders on top of the "pushed = done" self-serve protocol.

## Cleanup

Status files are not automatically pruned. A future issue can add a cron job to GC files older than 7 days. For now the directory is expected to accumulate ~1 file per PR per run.
