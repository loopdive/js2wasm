#!/bin/bash
# Notification gating — fire, delay, or cancel based on user activity.
#
# Behavior:
#   1. User idle > 5 minutes → fire IMMEDIATELY
#   2. Otherwise (user active within the last 5 min) → DEFER by 5 minutes.
#      If the user submits a prompt during the 5-minute window, the UserPromptSubmit
#      hook clears the pending-notify directory and the deferred send is cancelled.
#
# Stdin: the Claude Code Notification hook JSON payload.
# State files:
#   ~/.claude/last-user-activity     — unix timestamp of last UserPromptSubmit
#   ~/.claude/last-notification      — unix timestamp of last delivered notification
#   ~/.claude/pending-notify/<id>    — sentinel file per deferred send (holds the message)
#
# Cancellation protocol:
#   UserPromptSubmit hook does `find ~/.claude/pending-notify -type f -delete`
#   on every submit. The backgrounded sleeper re-checks its sentinel file after
#   sleep; missing = cancelled.

set -u

STATE_DIR="$HOME/.claude"
LAST_ACT_FILE="$STATE_DIR/last-user-activity"
LAST_NOTIFY_FILE="$STATE_DIR/last-notification"
PENDING_DIR="$STATE_DIR/pending-notify"
# NTFY_URL: defaults to a local docker-host endpoint; override via env to use any ntfy server.
# Set NTFY_URL=disabled to suppress notifications entirely (e.g. CI or public contributors).
NTFY_URL="${NTFY_URL:-http://host.docker.internal:8090/loopdive-claude}"
NTFY_TITLE="${NTFY_TITLE:-ts2wasm}"
[ "$NTFY_URL" = "disabled" ] && exit 0
IDLE_THRESHOLD=300   # 5 minutes
DELAY_SECONDS=300    # 5 minutes

mkdir -p "$STATE_DIR" "$PENDING_DIR"

INPUT=$(cat)
NOW=$(date +%s)
LAST_ACT=$(cat "$LAST_ACT_FILE" 2>/dev/null || echo 0)

IDLE=$((NOW - LAST_ACT))

MSG=$(printf '%s' "$INPUT" | jq -r '.message' 2>/dev/null | head -c 140)
[ -z "$MSG" ] && exit 0

send_now() {
  curl -s --max-time 5 -H "Title: $NTFY_TITLE" -d "$MSG" "$NTFY_URL" >/dev/null 2>&1 || true
  date +%s > "$LAST_NOTIFY_FILE"
}

# Gate: idle > 5 minutes → fire immediately
if [ "$IDLE" -gt "$IDLE_THRESHOLD" ]; then
  send_now
  exit 0
fi

# User is actively present — defer 5 minutes and let UserPromptSubmit cancel it.
SENTINEL="$PENDING_DIR/$NOW-$$"
printf '%s' "$MSG" > "$SENTINEL"

# Backgrounded sleeper. After 300s, re-check the sentinel; if still there, the user
# went silent for 5 min without responding, so fire. If gone, they responded → skip.
(
  sleep 300
  if [ -f "$SENTINEL" ]; then
    DEFERRED_MSG=$(cat "$SENTINEL" 2>/dev/null)
    if [ -n "$DEFERRED_MSG" ]; then
      curl -s --max-time 5 -H "Title: $NTFY_TITLE" -d "$DEFERRED_MSG" "$NTFY_URL" >/dev/null 2>&1 || true
      date +%s > "$LAST_NOTIFY_FILE"
    fi
    rm -f "$SENTINEL"
  fi
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true
exit 0
