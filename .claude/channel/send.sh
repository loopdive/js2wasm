#!/usr/bin/env bash
# Usage: ./send.sh <event> [json-payload]
# Examples:
#   ./send.sh test-run-done '{"passed":18043,"failed":312}'
#   ./send.sh cron-tick
#   ./send.sh custom '{"message":"hey, check the Array prototype failures"}'
curl -s -X POST http://localhost:7373/event \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"$1\",\"payload\":${2:-{}}}"
