#!/bin/bash
# PreToolUse hook: agents MUST NOT work in /workspace directly
# Only allowed in /workspace: git merge --ff-only, tech lead commits (CHECKLIST-FOXTROT)
# Everything else must happen in worktrees

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Only check git commands
if ! echo "$CMD" | grep -qE 'git (checkout|commit|merge|add|push|reset|revert|cherry-pick|branch)'; then
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

# ALLOW: git add + git commit with CHECKLIST-FOXTROT (tech lead commits)
if echo "$CMD" | grep -q 'CHECKLIST-FOXTROT'; then
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

# BLOCK everything else in /workspace
echo "BLOCKED: Do not run git commands in /workspace directly." >&2
echo "Work in your worktree instead. Only ff-only merges and tech lead commits are allowed in /workspace." >&2
exit 2
