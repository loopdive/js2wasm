#!/bin/bash
# PreToolUse hook for Bash: warn/block when git commands run from wrong directory
# Catches: tech lead accidentally in a worktree, agents operating on main

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Only check git commands that modify state
if ! echo "$CMD" | grep -qE 'git (commit|merge|add|push|reset|revert|cherry-pick)'; then
  exit 0
fi

# Block ff-only merge from anywhere except /workspace
if echo "$CMD" | grep -q 'git merge.*--ff-only'; then
  # Check if the command cd's to /workspace first, or we're already there
  if ! echo "$CMD" | grep -qE '^cd /workspace &&|^cd /workspace;'; then
    # No cd to /workspace — check current dir
    if [ "$PWD" != "/workspace" ]; then
      echo "BLOCKED: ff-only merge must run from /workspace. You appear to be in $PWD. Run: cd /workspace && git merge --ff-only <branch>" >&2
      exit 2
    fi
  fi
fi

# Warn if committing from /workspace on main (might be tech lead accident)
if echo "$CMD" | grep -q 'git commit'; then
  BRANCH=$(git branch --show-current 2>/dev/null)
  if [ "$BRANCH" = "main" ] && echo "$CMD" | grep -qv 'CHECKLIST-FOXTROT\|sprint\|plan\|docs\|chore'; then
    echo "WARNING: Committing to main directly. Is this intentional? Devs should commit in worktrees." >&2
  fi
fi

exit 0
