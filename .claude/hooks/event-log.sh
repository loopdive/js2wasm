#!/bin/bash
# Shared event logging function — append structured events to a JSONL log
# Usage: source this file, then call log_event "type" "key=value" "key=value" ...

EVENTS_LOG="/workspace/.claude/nonces/events.jsonl"

log_event() {
  local EVENT_TYPE="$1"
  shift

  local AVAIL_MB=$(free -m | awk '/Mem/{print $7}')
  local CLAUDE_COUNT=$(ps aux | grep -c '[c]laude')
  local VITEST_COUNT=$(ps aux | grep -c '[v]itest')

  # Build JSON with dynamic key-value pairs
  local JSON="{\"timestamp\":\"$(date -Iseconds)\",\"event\":\"$EVENT_TYPE\",\"available_mb\":$AVAIL_MB,\"claude_count\":$CLAUDE_COUNT,\"vitest_count\":$VITEST_COUNT"

  for kv in "$@"; do
    local key="${kv%%=*}"
    local val="${kv#*=}"
    # Quote strings, leave numbers bare
    if echo "$val" | grep -qE '^[0-9]+$'; then
      JSON="$JSON,\"$key\":$val"
    else
      JSON="$JSON,\"$key\":\"$val\""
    fi
  done

  JSON="$JSON}"
  echo "$JSON" >> "$EVENTS_LOG" 2>/dev/null
}
