#!/bin/bash
# PreToolUse hook: block sprint tags unless wrap-up checklist was followed.
# Checks for: git tag sprint/N or sprint-N/begin

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then exit 0; fi

# Only check git tag commands with sprint in the name
if ! echo "$CMD" | grep -qE 'git tag.*sprint'; then exit 0; fi

# Extract sprint number
SPRINT=$(echo "$CMD" | grep -oP 'sprint[/-](\d+)' | grep -oP '\d+' | head -1)
if [ -z "$SPRINT" ]; then exit 0; fi

# Check if sprint doc has been updated with results
SPRINT_FILE="/workspace/plan/sprints/sprint-${SPRINT}.md"
if [ -f "$SPRINT_FILE" ]; then
  if ! grep -qi "results\|final.*pass\|completed" "$SPRINT_FILE"; then
    echo "BLOCKED: Sprint $SPRINT doc ($SPRINT_FILE) has no results section." >&2
    echo "Run /sprint-wrap-up first to finalize the sprint before tagging." >&2
    exit 2
  fi
fi

exit 0
