#!/bin/bash
# Generate fresh nonce codes for all checklists
# Called by post-commit hook or on session start

NONCE_DIR="/workspace/.claude/nonces"
mkdir -p "$NONCE_DIR"

cat > "$NONCE_DIR/codes.json" <<EOF
{
  "pre-commit": "$(head -c 6 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8)",
  "pre-merge": "$(head -c 6 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8)",
  "pre-completion": "$(head -c 6 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8)",
  "generated": "$(date -Iseconds)"
}
EOF
