#!/bin/bash
# Monitor peak memory (VmHWM) of all relevant processes
# Tracks: vitest workers, compiler workers, claude agents — individually
# Run in background: bash .claude/hooks/monitor-memory.sh &

LOGFILE="/workspace/.claude/nonces/memory-monitor.jsonl"
echo "{\"event\":\"monitor_start\",\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$(free -m | awk '/Mem/{print $7}')}" >> "$LOGFILE"

while true; do
  # Check if any vitest or compiler is still running
  if ! ps aux | grep -qE '[v]itest|[c]ompiler-worker'; then
    # Final snapshot with peaks
    echo "{\"event\":\"monitor_end\",\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$(free -m | awk '/Mem/{print $7}')}" >> "$LOGFILE"
    break
  fi

  AVAIL=$(free -m | awk '/Mem/{print $7}')
  USED=$(free -m | awk '/Mem/{print $3}')
  ENTRY="{\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$AVAIL,\"used_mb\":$USED"

  # Vitest workers (each fork separately)
  ENTRY="$ENTRY,\"vitest\":["
  FIRST=true
  for pid in $(ps aux | grep '[v]itest' | awk '{print $2}'); do
    PEAK=$(grep VmHWM /proc/$pid/status 2>/dev/null | awk '{print $2}')
    RSS=$(grep VmRSS /proc/$pid/status 2>/dev/null | awk '{print $2}')
    NAME=$(ps -p $pid -o args= 2>/dev/null | head -c 40)
    if [ -n "$PEAK" ] && [ "$PEAK" -gt 10000 ]; then
      if [ "$FIRST" = true ]; then FIRST=false; else ENTRY="$ENTRY,"; fi
      ENTRY="$ENTRY{\"pid\":$pid,\"rss_mb\":$((RSS/1024)),\"peak_mb\":$((PEAK/1024)),\"name\":\"$(echo $NAME | tr '"' "'")\"}"
    fi
  done
  ENTRY="$ENTRY]"

  # Compiler workers
  ENTRY="$ENTRY,\"compiler\":["
  FIRST=true
  for pid in $(ps aux | grep '[c]ompiler-worker\|[c]ompiler-bundle\|esbuild' | awk '{print $2}'); do
    PEAK=$(grep VmHWM /proc/$pid/status 2>/dev/null | awk '{print $2}')
    RSS=$(grep VmRSS /proc/$pid/status 2>/dev/null | awk '{print $2}')
    if [ -n "$PEAK" ] && [ "$PEAK" -gt 10000 ]; then
      if [ "$FIRST" = true ]; then FIRST=false; else ENTRY="$ENTRY,"; fi
      ENTRY="$ENTRY{\"pid\":$pid,\"rss_mb\":$((RSS/1024)),\"peak_mb\":$((PEAK/1024))}"
    fi
  done
  ENTRY="$ENTRY]"

  # Claude agents
  ENTRY="$ENTRY,\"agents\":["
  FIRST=true
  for pid in $(ps aux | grep '[c]laude' | awk '{print $2}'); do
    PEAK=$(grep VmHWM /proc/$pid/status 2>/dev/null | awk '{print $2}')
    RSS=$(grep VmRSS /proc/$pid/status 2>/dev/null | awk '{print $2}')
    if [ -n "$PEAK" ] && [ "$PEAK" -gt 50000 ]; then
      if [ "$FIRST" = true ]; then FIRST=false; else ENTRY="$ENTRY,"; fi
      ENTRY="$ENTRY{\"pid\":$pid,\"rss_mb\":$((RSS/1024)),\"peak_mb\":$((PEAK/1024))}"
    fi
  done
  ENTRY="$ENTRY]}"

  echo "$ENTRY" >> "$LOGFILE"
  sleep 10
done
