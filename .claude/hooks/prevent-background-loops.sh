#!/bin/bash
# PreToolUse hook: block open-ended until/while loops in background Bash commands.
#
# Background shells (run_in_background: true) survive agent sessions as independent
# OS processes. An until/while loop waiting for a condition that never triggers
# (e.g. a file that is never written) will run indefinitely, preventing clean
# shutdown and consuming resources long after the agent terminates.
#
# Rule: if run_in_background=true AND the command contains an until/while polling
# loop (detected by the presence of 'until' or 'while' with 'sleep' and 'done'),
# the command MUST be wrapped with `timeout <seconds>` at the outer level.
#
# Correct pattern:
#   timeout 600 bash -c 'until [ -f /tmp/result.log ]; do sleep 10; done'
#
# Use the Monitor tool instead of polling loops where possible — Monitor delivers
# a notification when a background command produces output, with no polling needed.

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
RUN_IN_BG=$(echo "$INPUT" | jq -r '.tool_input.run_in_background // false' 2>/dev/null)

# Only check background commands
if [ -z "$CMD" ] || [ "$RUN_IN_BG" != "true" ]; then
  exit 0
fi

# Detect polling loops: until/while ... sleep ... done
HAS_LOOP=false
if echo "$CMD" | grep -qE '\buntil\b' && echo "$CMD" | grep -q 'sleep' && echo "$CMD" | grep -q 'done'; then
  HAS_LOOP=true
fi
if echo "$CMD" | grep -qE '\bwhile\b' && echo "$CMD" | grep -q 'sleep' && echo "$CMD" | grep -q 'done'; then
  HAS_LOOP=true
fi

if [ "$HAS_LOOP" = false ]; then
  exit 0
fi

# Require a top-level timeout wrapper
if echo "$CMD" | grep -qE '^[[:space:]]*(timeout|gtimeout)[[:space:]]'; then
  exit 0
fi

echo "BLOCKED: Background polling loop without top-level timeout wrapper." >&2
echo "" >&2
echo "Background shells survive agent sessions. A loop waiting for a condition" >&2
echo "that never triggers will run forever after the agent shuts down." >&2
echo "" >&2
echo "Wrap with timeout:" >&2
echo "  timeout 600 bash -c 'until [ -f /tmp/result.log ]; do sleep 10; done'" >&2
echo "" >&2
echo "Or use the Monitor tool to watch a background process without polling." >&2
exit 2
