#!/bin/bash
# PostToolUse hook: auto-format files after Edit/Write
# Runs prettier on the modified file to prevent formatting drift.

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
if [ -z "$FILE" ]; then
  exit 0
fi

# Only format supported file types
case "$FILE" in
  *.ts|*.js|*.mjs|*.json|*.html|*.css)
    npx prettier --write "$FILE" 2>/dev/null
    ;;
esac

exit 0
