#!/usr/bin/env bash
# Pre-test-lock hook: blocks test execution when another test is already running.
# Uses /tmp/js2wasm-test-lock directory as a mutex.
# Checks the Bash command for vitest/npm test/tsx patterns.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Only check commands that look like test invocations
if ! echo "$COMMAND" | grep -qiE 'vitest|npm test|npx tsx.*test|\.test\.|equivalence'; then
  exit 0
fi

# Check if lock exists AND is held by a different process
LOCKDIR="/tmp/js2wasm-test-lock"
if [ -d "$LOCKDIR" ]; then
  # Check if the lock holder PID is still alive
  PIDFILE="$LOCKDIR/pid"
  if [ -f "$PIDFILE" ]; then
    LOCK_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
      echo "BLOCKED: Test lock held by PID $LOCK_PID. Another test is already running."
      echo "Wait for it to finish, or verify the lock is stale: ls -la $LOCKDIR"
      exit 2
    else
      # Stale lock — PID is dead, clean up
      rm -rf "$LOCKDIR"
      exit 0
    fi
  fi
  # Lock dir exists but no pid file — could be stale
  # Check age: if older than 10 minutes, consider stale
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKDIR" 2>/dev/null || echo "0") ))
  if [ "$LOCK_AGE" -gt 600 ]; then
    rm -rf "$LOCKDIR"
    exit 0
  fi
  echo "BLOCKED: Test lock exists at $LOCKDIR (age: ${LOCK_AGE}s). Another test may be running."
  echo "If stale, remove it: rm -rf $LOCKDIR"
  exit 2
fi

exit 0
