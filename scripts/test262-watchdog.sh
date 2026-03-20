#!/bin/bash
# Watchdog for test262 runner — kills the process if no progress for 30s
# Usage: ./test262-watchdog.sh <pid>
# Typically run as: npx tsx scripts/run-test262.ts & ./scripts/test262-watchdog.sh $!

PID=${1:?Usage: test262-watchdog.sh <pid>}
JSONL="benchmarks/results/test262-results.jsonl"
TIMEOUT=30

echo "Watchdog: monitoring PID $PID, timeout ${TIMEOUT}s"

LAST_SIZE=0
STUCK_COUNT=0

while kill -0 "$PID" 2>/dev/null; do
  sleep 5
  SIZE=$(wc -c < "$JSONL" 2>/dev/null || echo 0)
  if [ "$SIZE" = "$LAST_SIZE" ]; then
    STUCK_COUNT=$((STUCK_COUNT + 5))
    if [ "$STUCK_COUNT" -ge "$TIMEOUT" ]; then
      LAST_TEST=$(tail -1 "$JSONL" 2>/dev/null | grep -o '"file":"[^"]*"' | head -1)
      echo ""
      echo "Watchdog: no progress for ${TIMEOUT}s (stuck after $LAST_TEST), killing PID $PID"
      kill "$PID" 2>/dev/null
      sleep 1
      kill -9 "$PID" 2>/dev/null
      echo "Watchdog: run 'npx tsx scripts/run-test262.ts --resume' to continue"
      exit 1
    fi
  else
    STUCK_COUNT=0
    LAST_SIZE=$SIZE
  fi
done

echo "Watchdog: process $PID exited"
