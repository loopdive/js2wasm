#!/bin/bash
# Pre-test hook:
# - Block direct test262 vitest runs (must use pnpm run test:262 which has flock)
# - Allow equivalence tests directly
# - Check RAM

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then
  exit 0
fi

# Allow equivalence tests directly — no flock needed
if echo "$CMD" | grep -q 'equivalence'; then
  AVAIL_MB=$(free -m | awk '/Mem/{print $7}')
  if [ "$AVAIL_MB" -lt 2000 ]; then
    echo "BLOCKED: Only ${AVAIL_MB}MB available RAM." >&2
    exit 2
  fi
  exit 0
fi

# Block direct vitest/npx runs on test262 — must go through the script
# Only match actual run commands (vitest run, npx vitest), not git add/commit on test files
if echo "$CMD" | grep -qE '(vitest run|npx vitest).*test262'; then
  if ! echo "$CMD" | grep -qE 'pnpm run test:262|scripts/run-test262'; then
    echo "BLOCKED: Direct test262 runs are not allowed." >&2
    echo "Use: pnpm run test:262" >&2
    echo "The test script uses flock for exclusive access and writes timestamped results." >&2
    exit 2
  fi
fi

# RAM check for any test command
if echo "$CMD" | grep -qE 'npm test|vitest|pnpm run test'; then
  AVAIL_MB=$(free -m | awk '/Mem/{print $7}')
  if [ "$AVAIL_MB" -lt 2000 ]; then
    echo "BLOCKED: Only ${AVAIL_MB}MB available RAM." >&2
    exit 2
  fi
  OTHER=$(ps aux | grep -c '[v]itest')
  if [ "$OTHER" -gt 0 ]; then
    jq -n --arg ctx "WARNING: ${OTHER} vitest process(es) running. RAM: ${AVAIL_MB}MB." \
      '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
  fi
fi

exit 0
