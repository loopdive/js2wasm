#!/bin/bash
# Pre-shutdown hook: check context summary, log event
INPUT=$(cat)
MSG=$(echo "$INPUT" | jq -r '.tool_input.message.type // empty' 2>/dev/null)

if [ "$MSG" != "shutdown_request" ]; then
  exit 0
fi

AGENT=$(echo "$INPUT" | jq -r '.tool_input.to // empty' 2>/dev/null)

# Log the shutdown event
source /workspace/.claude/hooks/event-log.sh
log_event "agent_shutdown" "agent=$AGENT"

# Check if context summary exists
if [ -n "$AGENT" ] && [ ! -f "/workspace/plan/agent-context/${AGENT}.md" ]; then
  log_event "agent_shutdown_blocked" "agent=$AGENT" "reason=no_context_summary"
  echo "BLOCKED: No context summary at plan/agent-context/${AGENT}.md. Ask the agent to write one first." >&2
  exit 2
fi

echo "REMINDER: Have you confirmed the user is not still talking to ${AGENT}?" >&2
exit 0
