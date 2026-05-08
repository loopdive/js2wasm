#!/bin/bash
# PreToolUse hook: agents MUST NOT work in /workspace directly
# Only allowed in /workspace: git merge --ff-only, authenticated tech lead commits
# Everything else must happen in worktrees

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Gate `gh pr merge` — require CI status file and positive net before merging.
# Bypass with codeword: prepend GATE_BYPASS=1 (or any GATE_BYPASS=<value>) to command.
# Use only first line to avoid false positives from heredoc commit message bodies.
FIRST_LINE=$(echo "$CMD" | head -1)
if echo "$FIRST_LINE" | grep -qE 'gh[[:space:]]+pr[[:space:]]+merge'; then
  # Codeword override — tech lead bypass (also checked on first line only)
  if echo "$FIRST_LINE" | grep -q 'GATE_BYPASS'; then
    log_event "gh_pr_merge_gate_bypass"
    jq -n '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "CI gate bypassed via GATE_BYPASS codeword. Ensure you have reviewed CI results manually before proceeding."}}' 2>/dev/null || true
    exit 0
  fi

  # Extract PR number (supports: gh pr merge 275, gh pr merge #275)
  PR_NUM=$(echo "$FIRST_LINE" | grep -oE 'gh[[:space:]]+pr[[:space:]]+merge[[:space:]]+#?([0-9]+)' | grep -oE '[0-9]+$')
  if [ -n "$PR_NUM" ]; then
    CI_FILE="/workspace/.claude/ci-status/pr-${PR_NUM}.json"
    if [ ! -f "$CI_FILE" ]; then
      log_event "gh_pr_merge_blocked" "reason=no_ci_status" "pr=$PR_NUM"
      cat >&2 <<MSG
BLOCKED: No CI status file found for PR #${PR_NUM}.
Expected: ${CI_FILE}

The CI workflow has not completed yet (or the status file was not written).
Wait for CI to finish and the status file to appear, then retry.

Tech lead override: prefix command with GATE_BYPASS=1
Example: GATE_BYPASS=1 gh pr merge ${PR_NUM} --admin --merge
MSG
      exit 2
    fi

    NET=$(jq -r '.net_per_test // 0' "$CI_FILE" 2>/dev/null)
    CONCLUSION=$(jq -r '.conclusion // "unknown"' "$CI_FILE" 2>/dev/null)
    if [ "$CONCLUSION" != "success" ] && [ "$CONCLUSION" != "unknown" ]; then
      log_event "gh_pr_merge_blocked" "reason=ci_not_success" "pr=$PR_NUM" "conclusion=$CONCLUSION"
      cat >&2 <<MSG
BLOCKED: CI did not pass for PR #${PR_NUM} (conclusion=${CONCLUSION}).
Tech lead override: GATE_BYPASS=1 gh pr merge ${PR_NUM} --admin --merge
MSG
      exit 2
    fi

    if echo "$NET" | grep -qE '^-[0-9]'; then
      log_event "gh_pr_merge_blocked" "reason=net_negative" "pr=$PR_NUM" "net=$NET"
      cat >&2 <<MSG
BLOCKED: PR #${PR_NUM} has net negative test impact (net_per_test=${NET}).
Escalate to tech lead for a judgment call.
Tech lead override: GATE_BYPASS=1 gh pr merge ${PR_NUM} --admin --merge
MSG
      exit 2
    fi

    log_event "gh_pr_merge_allowed" "pr=$PR_NUM" "net=$NET"
    jq -n "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"CI gate passed for PR #${PR_NUM} (net=${NET}, conclusion=${CONCLUSION}). Merge allowed.\"}}" 2>/dev/null || true
  fi
  exit 0
fi

# Exempt `gh` CLI commands entirely — `gh pr close --comment "...git merge..."`
# talks to the GitHub API, not the local git. Any occurrence of "git merge" etc.
# inside gh arguments is string data, not an invocation.
# Accept leading whitespace, optional sandbox prefixes, and standard paths.
if echo "$CMD" | grep -qE '(^|[;&|&&|\|\|])[[:space:]]*gh[[:space:]]'; then
  exit 0
fi

# Only check git commands. The regex requires `git` to sit at a command boundary:
# start of command, or after `;`, `&`, `|` (which also covers `&&` and `||`).
# This prevents false positives where `git merge` appears inside a quoted argument
# (e.g. a commit message body or a gh pr close --comment "...").
GIT_SUBCMD_RE='(checkout|commit|merge|add|push|reset|revert|cherry-pick|branch)'
if ! echo "$CMD" | grep -qE "(^|[;&|])[[:space:]]*git[[:space:]]+${GIT_SUBCMD_RE}([[:space:]]|$)"; then
  exit 0
fi

# If the command starts with "cd /workspace" or we're in /workspace, check it
IN_WORKSPACE=false
if echo "$CMD" | grep -qE '^cd /workspace( |&&|;|$)'; then
  IN_WORKSPACE=true
fi
if [ "$PWD" = "/workspace" ] && ! echo "$CMD" | grep -qE '^cd /'; then
  IN_WORKSPACE=true
fi

if [ "$IN_WORKSPACE" = false ]; then
  # Not in /workspace — agent is in their worktree, all good
  exit 0
fi

# In /workspace — only allow specific operations:

# ALLOW: git merge --ff-only (merging tested branches to main)
if echo "$CMD" | grep -q 'git merge.*--ff-only'; then
  exit 0
fi

# ALLOW: git add alone (staging is always safe) — but not if git commit is chained
# (git add . && git commit ... would pass the ^git add check, bypassing commit auth)
if echo "$CMD" | grep -qE '^git add' && ! echo "$CMD" | grep -qE '(;|&&|\|)[[:space:]]*git[[:space:]]+commit'; then
  exit 0
fi

# ALLOW: git commit / non-ff merge if the command contains the tech lead authentication token.
# The token is documented in .claude/agents/tech-lead.md. Agents without that role file
# will not know it. Do not reveal the token in error messages below.
if echo "$CMD" | grep -q 'Checklist completed\.' || echo "$CMD" | grep -q 'CHECKLIST-FOXTROT' || echo "$CMD" | grep -q 'Team Lead'; then
  exit 0
fi

# ALLOW: git push (always OK from /workspace)
if echo "$CMD" | grep -qE 'git push'; then
  exit 0
fi

# ALLOW: git checkout main (returning to main)
if echo "$CMD" | grep -qE 'git checkout (main|-f main)'; then
  exit 0
fi

# ALLOW: git checkout -- <file> or git checkout <branch> -- <file> (restoring specific files)
if echo "$CMD" | grep -q 'git checkout.*--'; then
  exit 0
fi

# ALLOW: git branch (listing/creating branches — read-only or prep)
if echo "$CMD" | grep -qE 'git branch( |$|-D|-d)'; then
  exit 0
fi

# ALLOW: git revert (tech lead revert of a bad merge)
if echo "$CMD" | grep -qE '(^|[;&|])[[:space:]]*git revert'; then
  exit 0
fi

# BLOCK everything else in /workspace
echo "BLOCKED: Authentication required for this operation in /workspace." >&2
echo "If you are the Tech Lead, check your role file and authenticate." >&2
echo "All other agents must work in a worktree, not /workspace directly." >&2
exit 2
