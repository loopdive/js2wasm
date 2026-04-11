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
#   - If conclusion=success and delta is positive: no action needed, the
#     tech lead will merge. Safe to stay on current task.
#   - If conclusion=success but delta is negative or regressions look
#     real: context-switch back to the PR and investigate.
#   - If conclusion=failure: context-switch back and fix.

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
delta=$(jq -r '.delta // "unknown"' "$FILE")
regressions=$(jq -r '.regressions // "unknown"' "$FILE")
improvements=$(jq -r '.improvements // "unknown"' "$FILE")
run_url=$(jq -r '.run_url // ""' "$FILE")

# Compose a reminder tailored to the result
if [ "$conclusion" = "success" ] && [ "$delta" != "unknown" ] && [ "$delta" -ge 0 ] 2>/dev/null; then
  reminder="CI completed for YOUR PR #$pr_num: conclusion=success, delta=+$delta (improvements=$improvements, regressions=$regressions). The tech lead will merge asynchronously. No action needed — stay on your current task."
elif [ "$conclusion" = "success" ]; then
  reminder="CI completed for YOUR PR #$pr_num: conclusion=success but delta=$delta (improvements=$improvements, regressions=$regressions). Consider context-switching back to sample the regressions and decide whether to narrow the fix or close. Run URL: $run_url"
else
  reminder="CI FAILED for YOUR PR #$pr_num: conclusion=$conclusion, delta=$delta, regressions=$regressions. Context-switch back to your worktree and investigate. Run URL: $run_url"
fi

# Emit as additional context injected into the model turn
jq -n --arg msg "$reminder" '{
  hookSpecificOutput: {
    hookEventName: "FileChanged",
    additionalContext: $msg
  }
}'
exit 0
