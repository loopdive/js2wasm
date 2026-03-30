#!/bin/bash
# Pre-test hook: check RAM, warn about parallel tests, log memory
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if [ -z "$CMD" ]; then exit 0; fi
if ! echo "$CMD" | grep -qE 'npm test|vitest|pnpm run test'; then exit 0; fi

AVAIL_MB=$(free -m | awk '/Mem/{print $7}')
if [ "$AVAIL_MB" -lt 2000 ]; then
  echo "BLOCKED: Only ${AVAIL_MB}MB available RAM. Need >2GB for tests." >&2
  exit 2
fi

OTHER_TESTS=$(ps aux | grep -c '[v]itest')

# Log pre-test memory snapshot
LOGFILE="/workspace/.claude/nonces/test-memory-log.jsonl"
TYPE="unknown"
if echo "$CMD" | grep -q 'equivalence'; then TYPE="equiv"; elif echo "$CMD" | grep -q 'test262'; then TYPE="test262"; fi
CLAUDE_MB=$(ps aux | grep '[c]laude' | awk '{sum+=$6} END {print int(sum/1024)}')
echo "{\"timestamp\":\"$(date -Iseconds)\",\"phase\":\"pre\",\"type\":\"$TYPE\",\"available_mb\":$AVAIL_MB,\"claude_total_mb\":$CLAUDE_MB,\"other_tests\":$OTHER_TESTS}" >> "$LOGFILE" 2>/dev/null

if [ "$OTHER_TESTS" -gt 0 ]; then
  jq -n --arg ctx "WARNING: ${OTHER_TESTS} other vitest process(es) running. Available RAM: ${AVAIL_MB}MB." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
else
  jq -n --arg ctx "RAM: ${AVAIL_MB}MB available. No other tests running." \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}'
fi
exit 0
