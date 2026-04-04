#!/bin/bash
# Pre-commit hook: block dangerous patterns, inject checklist as guidance
# Lightweight — no sign-off ceremony, just safety checks + context injection

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Block git add -A, git add --all, git add . (only bare dot as sole arg)
FIRST_LINE=$(echo "$CMD" | head -1)
if echo "$FIRST_LINE" | grep -qE '^git add (-A|--all|\.)$|^git add (-A|--all|\.) '; then
  echo "BLOCKED: Never use 'git add -A', 'git add --all', or 'git add .' — stage specific files only." >&2
  exit 2
fi

# Block committing on main from wrong directory
BRANCH=$(git branch --show-current 2>/dev/null)
if [ "$BRANCH" = "main" ] && [ "$PWD" != "/workspace" ]; then
  echo "BLOCKED: On main but pwd is $PWD (not /workspace). Are you in a worktree?" >&2
  exit 2
fi

# For git commit: format, lint, check code word, inject guidance
if echo "$CMD" | grep -q 'git commit'; then
  # Auto-format staged files with prettier
  cd /workspace
  STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E '\.(ts|js|mjs|json)$' | head -50)
  if [ -n "$STAGED" ]; then
    echo "$STAGED" | xargs npx prettier --write 2>/dev/null
    echo "$STAGED" | xargs git add 2>/dev/null
  fi

  # Lint with biome (error-level only)
  npx biome lint --diagnostic-level=error 2>/dev/null || true

  # Verify code word from pre-commit checklist
  if ! echo "$CMD" | grep -q 'CHECKLIST-FOXTROT'; then
    echo "BLOCKED: Missing code word. Read plan/pre-commit-checklist.md for instructions." >&2
    exit 2
  fi
  CHECKLIST=$(head -15 /workspace/plan/pre-commit-checklist.md 2>/dev/null)
  if [ -n "$CHECKLIST" ]; then
    jq -n --arg ctx "VERIFY BEFORE COMMITTING: pwd=$(pwd) branch=$BRANCH. Have you checked: specific files staged? diff reviewed? no accidental deletions?" \
      '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
  fi
fi

exit 0
