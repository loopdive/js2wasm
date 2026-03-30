#!/bin/bash
# Pre-agent-spawn hook: check RAM, log event
INPUT=$(cat)
AVAIL_MB=$(free -m | awk '/Mem/{print $7}')
AGENT_COUNT=$(ps aux | grep -c '[c]laude')

# Extract agent name/type from input
AGENT_NAME=$(echo "$INPUT" | jq -r '.tool_input.name // "unknown"' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general"' 2>/dev/null)

# Log the spawn event
source /workspace/.claude/hooks/event-log.sh
log_event "agent_spawn" "agent=$AGENT_NAME" "type=$AGENT_TYPE" "ram_mb=$AVAIL_MB"

if [ "$AVAIL_MB" -lt 1500 ]; then
  log_event "agent_spawn_blocked" "agent=$AGENT_NAME" "reason=low_ram" "ram_mb=$AVAIL_MB"
  echo "BLOCKED: Only ${AVAIL_MB}MB available RAM with ${AGENT_COUNT} agents running." >&2
  exit 2
fi

if [ "$AGENT_COUNT" -gt 8 ]; then
  echo "WARNING: ${AGENT_COUNT} Claude processes running. Available RAM: ${AVAIL_MB}MB." >&2
fi

exit 0
