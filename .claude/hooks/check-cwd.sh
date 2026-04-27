#!/bin/bash
# PreToolUse hook: agents MUST NOT work in /workspace directly
# Only allowed in /workspace: git merge --ff-only, tech lead commits (TECH_LEAD=1 env var)
# Everything else must happen in worktrees

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
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

# ALLOW: git add (staging files is always safe)
if echo "$CMD" | grep -qE '^git add'; then
  exit 0
fi

# ALLOW: git commit / merge (non-ff) if TECH_LEAD env var is set — tech lead only
# Set `export TECH_LEAD=1` in your shell profile (~/.zshrc). Agents spawn without
# sourcing the profile so they never inherit this, preventing CHECKLIST-FOXTROT spoofing.
if [ -n "$TECH_LEAD" ]; then
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

# ALLOW: git revert (tech lead revert of a bad merge, commit message gets CHECKLIST-FOXTROT on the follow-up)
if echo "$CMD" | grep -qE '(^|[;&|])[[:space:]]*git revert'; then
  exit 0
fi

# BLOCK everything else in /workspace
echo "BLOCKED: Do not run git commands in /workspace directly." >&2
echo "Work in your worktree instead. Only ff-only merges and tech lead commits are allowed in /workspace." >&2
exit 2
