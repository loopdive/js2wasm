#!/bin/bash
# FileChanged hook: watches .claude/ci-status/pr-*.json and injects a
# system reminder when a file matching the current dev's own PR is
# created or updated.
#
# Stdin: Claude Code FileChanged hook payload (JSON with .file_path).
# Output: JSON with hookSpecificOutput.additionalContext when the dev
# should react (PR finished and it's theirs); empty otherwise.
#
# How the dev "owns" a PR:
#   The hook looks at `gh pr list --author @me --state open --json number`
#   and matches against the file name. If the file is for a PR authored
#   by this dev, react. Otherwise ignore.
#
# Dev protocol on reacting:
#   - If conclusion=success and net_per_test is positive: no action needed,
#     the tech lead will merge. Safe to stay on current task.
#   - If conclusion=success but net_per_test is negative or regressions look
#     real: context-switch back to the PR and investigate.
#   - If conclusion=failure: context-switch back and fix.
#
# Note: `snapshot_delta` is an absolute pass-count diff vs the committed
# baseline file. It is NOT the merge gate (see #1082). The authoritative
# per-test metric is `net_per_test = improvements − regressions`.

set -u

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

# Only react to ci-status files
case "$FILE" in
  */.claude/ci-status/pr-*.json) ;;
  *) exit 0 ;;
esac

# Extract the PR number from the filename
pr_num=$(basename "$FILE" .json | sed 's/^pr-//')
[ -z "$pr_num" ] && exit 0

# Is this PR authored by this dev (current git user / gh user)?
# Use gh api to check the author; match against this environment's gh identity.
my_prs=$(gh pr list --author @me --state all --limit 30 --json number 2>/dev/null | jq -r '.[].number' 2>/dev/null || echo "")
is_mine=false
for n in $my_prs; do
  if [ "$n" = "$pr_num" ]; then
    is_mine=true
    break
  fi
done

if [ "$is_mine" = "false" ]; then
  # Not this dev's PR — skip silently
  exit 0
fi

# Read the status file content
if [ ! -f "$FILE" ]; then
  exit 0
fi

conclusion=$(jq -r '.conclusion // "unknown"' "$FILE")
# net_per_test is the authoritative merge gate (improvements − regressions).
# Fall back to legacy `delta` field for status files written before #1082.
net_per_test=$(jq -r '.net_per_test // .delta // "unknown"' "$FILE")
snapshot_delta=$(jq -r '.snapshot_delta // .delta // "unknown"' "$FILE")
regressions=$(jq -r '.regressions // "unknown"' "$FILE")
improvements=$(jq -r '.improvements // "unknown"' "$FILE")
run_url=$(jq -r '.run_url // ""' "$FILE")

# Compose a reminder tailored to the result. Gate on net_per_test (per-test),
# not snapshot_delta (can lie when the committed baseline is stale — see #1082).
if [ "$conclusion" = "success" ] && [ "$net_per_test" != "unknown" ] && [ "$net_per_test" -ge 0 ] 2>/dev/null; then
  reminder="CI completed for YOUR PR #$pr_num: conclusion=success, net_per_test=+$net_per_test (improvements=$improvements, regressions=$regressions, snapshot_delta=$snapshot_delta). You may self-merge per .claude/skills/dev-self-merge.md if ratio and scope criteria also hold. Otherwise stay on your current task."
elif [ "$conclusion" = "success" ]; then
  reminder="CI completed for YOUR PR #$pr_num: conclusion=success but net_per_test=$net_per_test (improvements=$improvements, regressions=$regressions, snapshot_delta=$snapshot_delta). Context-switch back, sample the regressions, decide whether to narrow the fix or close. Run URL: $run_url"
else
  reminder="CI FAILED for YOUR PR #$pr_num: conclusion=$conclusion, net_per_test=$net_per_test, regressions=$regressions. Context-switch back to your worktree and investigate. Run URL: $run_url"
fi

# Emit as additional context injected into the model turn
jq -n --arg msg "$reminder" '{
  hookSpecificOutput: {
    hookEventName: "FileChanged",
    additionalContext: $msg
  }
}'
exit 0
