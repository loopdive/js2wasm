#!/bin/bash
# Check for recent OOM kills and log them
# Run periodically or after suspected OOM events

source /workspace/.claude/hooks/event-log.sh

# Check dmesg for OOM kills (last 5 min)
OOM_COUNT=$(dmesg --time-format iso 2>/dev/null | tail -100 | grep -c "Out of memory\|oom-kill\|Killed process" || echo 0)
if [ "$OOM_COUNT" -gt 0 ]; then
  VICTIMS=$(dmesg --time-format iso 2>/dev/null | tail -100 | grep "Killed process" | tail -3 | awk '{print $NF}' | tr '\n' ',' )
  log_event "oom_detected" "count=$OOM_COUNT" "victims=$VICTIMS"
fi

# Check for disappeared claude/vitest processes (compare to previous snapshot)
SNAPSHOT="/tmp/ts2wasm-process-snapshot.txt"
CURRENT_PIDS=$(ps aux | grep -E '[c]laude|[v]itest' | awk '{print $2}' | sort)

if [ -f "$SNAPSHOT" ]; then
  PREV_PIDS=$(cat "$SNAPSHOT")
  DISAPPEARED=$(comm -23 <(echo "$PREV_PIDS") <(echo "$CURRENT_PIDS"))
  if [ -n "$DISAPPEARED" ]; then
    COUNT=$(echo "$DISAPPEARED" | wc -l)
    log_event "process_disappeared" "count=$COUNT" "pids=$(echo $DISAPPEARED | tr '\n' ',')"
  fi
fi

echo "$CURRENT_PIDS" > "$SNAPSHOT"
