#!/bin/bash
# Pre-merge hook: enforce merge protocol
# Key insight: hooks run from /workspace, not from agent's cwd.
# We detect intent from the command string, not from git state.
# Exit 0 = allow, Exit 2 = block

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

if ! echo "$CMD" | grep -q 'git merge'; then
  exit 0
fi

source /workspace/.claude/hooks/event-log.sh

# Detect: is this merging TO main (ff-only) or merging main INTO a branch?
# ff-only anywhere in the command = merging to main
if echo "$CMD" | grep -q '\-\-ff-only'; then
  # Merging TO main — require test proof
  # Check both the main workspace and the branch's worktree for the proof file
  PROOF=""
  BRANCH=$(echo "$CMD" | sed 's/.*--ff-only[[:space:]]*//' | awk '{print $1}')
  # Try worktree path for the branch
  for candidate in \
    "/workspace/.claude/worktrees/$BRANCH/.claude/nonces/merge-proof.json" \
    "/workspace/.claude/nonces/merge-proof.json"; do
    if [ -f "$candidate" ]; then
      PROOF="$candidate"
      break
    fi
  done
  if [ -z "$PROOF" ]; then
    log_event "merge_blocked" "reason=no_proof"
    cat >&2 <<'MSG'
BLOCKED: No test proof found. Before merging to main:

1. On your dev branch: git merge main
2. On your dev branch: run equiv tests
3. Create proof: see .claude/skills/test-and-merge.md step 7

Tests must pass ON THE INTEGRATED BRANCH before merging to main.
MSG
    exit 2
  fi

  # Validate proof is recent (< 15 min)
  TS=$(jq -r '.timestamp // empty' "$PROOF" 2>/dev/null)
  if [ -n "$TS" ]; then
    TS_EPOCH=$(date -d "$TS" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    AGE=$(( NOW_EPOCH - TS_EPOCH ))
    if [ "$AGE" -gt 900 ]; then
      log_event "merge_blocked" "reason=proof_expired" "age=$AGE"
      echo "BLOCKED: Test proof is ${AGE}s old (max 900s). Re-run tests." >&2
      rm -f "$PROOF"
      exit 2
    fi
  fi

  EQUIV=$(jq -r '.equiv_passed // false' "$PROOF" 2>/dev/null)
  if [ "$EQUIV" != "true" ]; then
    log_event "merge_blocked" "reason=equiv_failed"
    echo "BLOCKED: Equivalence tests did not pass." >&2
    rm -f "$PROOF"
    exit 2
  fi

  BRANCH=$(jq -r '.branch // "unknown"' "$PROOF" 2>/dev/null)
  log_event "merge_to_main" "branch=$BRANCH"

  # Valid — consume proof
  rm -f "$PROOF"
  jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "Test proof validated. POST-MERGE: verify no deletions, move issue to done/, update dep graph."}}'
  exit 0
fi

# No --ff-only = merging main into a branch (always allowed)
# This includes: "git merge main", "cd <worktree> && git merge main", etc.
log_event "merge_into_branch"
jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: "Merging main into your branch. After merge: run equiv tests, create proof, then ff-only to main."}}'
exit 0
