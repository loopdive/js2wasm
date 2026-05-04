#!/bin/bash
# PreToolUse hook: agents MUST NOT work in /workspace directly
# Only allowed in /workspace: git merge --ff-only, authenticated tech lead commits
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
