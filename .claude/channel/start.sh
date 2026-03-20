#!/usr/bin/env bash
# Starts the channel server in the background, logs to .claude/channel/server.log
cd "$(dirname "$0")"
pkill -f "channel/server" 2>/dev/null
nohup bun run server.ts > server.log 2>&1 &
echo $! > server.pid
echo "Channel server started (pid $(cat server.pid)), listening on :7373"
