#!/bin/bash
# Post-test hook: log peak memory for future estimation
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then exit 0; fi
if ! echo "$CMD" | grep -qE 'npm test|vitest|pnpm run test'; then exit 0; fi

LOGFILE="/workspace/.claude/nonces/test-memory-log.jsonl"
AVAIL=$(free -m | awk '/Mem/{print $7}')
TYPE="unknown"
if echo "$CMD" | grep -q 'equivalence'; then TYPE="equiv"; elif echo "$CMD" | grep -q 'test262'; then TYPE="test262"; fi

PEAKS=""
for pid in $(ps aux | grep '[v]itest' | awk '{print $2}'); do
  peak=$(grep VmHWM /proc/$pid/status 2>/dev/null | awk '{print $2}')
  if [ -n "$peak" ] && [ "$peak" -gt 50000 ]; then PEAKS="${PEAKS}${peak},"; fi
done

echo "{\"timestamp\":\"$(date -Iseconds)\",\"phase\":\"post\",\"type\":\"$TYPE\",\"available_mb\":$AVAIL,\"vitest_peaks_kb\":\"$PEAKS\"}" >> "$LOGFILE" 2>/dev/null
exit 0
