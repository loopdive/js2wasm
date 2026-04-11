#!/bin/bash
# Notification gating — only send a push notification if:
#  1. the user has been idle for > 10 minutes (no UserPromptSubmit in that window), OR
#  2. a prior notification was sent since the user's last activity AND >5 min passed
#     since that prior notification (i.e. user didn't respond to a previous ping)
#
# Stdin: the Claude Code Notification hook JSON payload.
# State files (idempotent, auto-created):
#   ~/.claude/last-user-activity    — unix timestamp of last UserPromptSubmit
#   ~/.claude/last-notification     — unix timestamp of last sent notification

set -u

STATE_DIR="$HOME/.claude"
LAST_ACT_FILE="$STATE_DIR/last-user-activity"
LAST_NOTIFY_FILE="$STATE_DIR/last-notification"
mkdir -p "$STATE_DIR"

# Capture stdin first — jq will consume it later.
INPUT=$(cat)

NOW=$(date +%s)
LAST_ACT=$(cat "$LAST_ACT_FILE" 2>/dev/null || echo 0)
LAST_NOTIFY=$(cat "$LAST_NOTIFY_FILE" 2>/dev/null || echo 0)

IDLE=$((NOW - LAST_ACT))
SINCE_NOTIFY=$((NOW - LAST_NOTIFY))

# Gate 1: user idle for > 10 minutes (600s)
GATE1=$([ "$IDLE" -gt 600 ] && echo 1 || echo 0)

# Gate 2: we notified since the user's last activity AND > 5 min (300s) passed
# (covers: we pinged, user didn't respond, nag again)
GATE2=0
if [ "$LAST_NOTIFY" -gt "$LAST_ACT" ] && [ "$SINCE_NOTIFY" -gt 300 ]; then
  GATE2=1
fi

if [ "$GATE1" -eq 0 ] && [ "$GATE2" -eq 0 ]; then
  # Suppress: user is actively present.
  exit 0
fi

# Fire the notification — same command as the pre-gate version.
MSG=$(echo "$INPUT" | jq -r '.message' 2>/dev/null | head -c 140)
if [ -z "$MSG" ]; then
  exit 0
fi

curl -s --max-time 5 -H 'Title: ts2wasm' -d "$MSG" http://host.docker.internal:8090/loopdive-claude >/dev/null 2>&1 || true

# Record that we just sent.
echo "$NOW" > "$LAST_NOTIFY_FILE"
exit 0
