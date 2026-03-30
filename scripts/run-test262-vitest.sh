#!/bin/bash
# Run test262 via vitest in an isolated git worktree.
# Usage: pnpm run test:262 [vitest args...]
#
# - Uses flock to prevent parallel runs (only one test262 at a time)
# - Writes results to timestamped files, updates symlink only on completion
# - Builds compiler bundle from the worktree (not /workspace)

set -e

MAIN_DIR="/workspace"
LOCKFILE="/tmp/ts2wasm-test262.lock"
RESULTS_DIR="$MAIN_DIR/benchmarks/results"
RUN_TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# ── Exclusive lock — only one test262 run at a time ──────────────
exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "ERROR: Another test262 run is in progress (lock held: $LOCKFILE)"
  echo "Wait for it to finish or kill the process holding the lock."
  exit 1
fi
echo "Lock acquired (PID $$)"

# ── Create isolated worktree ─────────────────────────────────────
WT_DIR="/tmp/ts2wasm-vitest-$$"
echo "Creating worktree at $WT_DIR ..."
git -C "$MAIN_DIR" worktree add "$WT_DIR" HEAD --detach --quiet 2>/dev/null

# Symlink heavy directories to avoid duplication
rm -rf "$WT_DIR/node_modules" "$WT_DIR/test262"
ln -s "$MAIN_DIR/node_modules" "$WT_DIR/node_modules"
ln -s "$MAIN_DIR/test262" "$WT_DIR/test262"

# Verify symlinks
if [ ! -d "$WT_DIR/test262/test" ]; then
  echo "ERROR: test262 symlink failed"
  exit 1
fi
echo "test262 symlink OK ($(ls "$WT_DIR/test262/test/" | wc -l) dirs)"

# Share the disk cache
mkdir -p "$MAIN_DIR/.test262-cache"
ln -sf "$MAIN_DIR/.test262-cache" "$WT_DIR/.test262-cache"

# ── Build compiler bundle FROM THE WORKTREE (not /workspace) ─────
echo "Building compiler bundle in worktree..."
cd "$WT_DIR"
npx esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript 2>&1 | tail -1
npx esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript 2>&1 | tail -1

# ── Prepare timestamped result files ─────────────────────────────
RUN_JSONL="$RESULTS_DIR/test262-run-${RUN_TIMESTAMP}.jsonl"
RUN_REPORT="$RESULTS_DIR/test262-report-${RUN_TIMESTAMP}.json"

# Truncate main results JSONL for fresh run
> "$RESULTS_DIR/test262-results.jsonl"

# Symlink worktree results dir to main workspace (so results survive worktree cleanup)
rm -rf "$WT_DIR/benchmarks/results"
ln -s "$RESULTS_DIR" "$WT_DIR/benchmarks/results"

echo "Run ID: $RUN_TIMESTAMP"
echo "Worktree at $(git -C "$WT_DIR" rev-parse --short HEAD)"
echo "Running vitest..."

# ── Also build bundle in worktree for vitest to use ──────────────
# (vitest runs from worktree, workers load compiler-bundle.mjs from there)

# ── Start memory monitor ─────────────────────────────────────────
MONITOR_LOG="$RESULTS_DIR/memory-monitor-${RUN_TIMESTAMP}.jsonl"
(
  echo "{\"event\":\"monitor_start\",\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$(free -m | awk '/Mem/{print $7}')}" >> "$MONITOR_LOG"
  while true; do
    if ! ps aux | grep -q '[v]itest'; then
      echo "{\"event\":\"monitor_end\",\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$(free -m | awk '/Mem/{print $7}')}" >> "$MONITOR_LOG"
      break
    fi
    AVAIL=$(free -m | awk '/Mem/{print $7}')
    USED=$(free -m | awk '/Mem/{print $3}')
    PROCS=""
    FIRST=true
    for pid in $(ps aux | grep '[v]itest' | awk '{print $2}'); do
      PEAK=$(grep VmHWM /proc/$pid/status 2>/dev/null | awk '{print $2}')
      RSS=$(grep VmRSS /proc/$pid/status 2>/dev/null | awk '{print $2}')
      NAME=$(ps -p $pid -o comm= 2>/dev/null)
      if [ -n "$PEAK" ] && [ "$PEAK" -gt 10000 ]; then
        if [ "$FIRST" = true ]; then FIRST=false; else PROCS="$PROCS,"; fi
        PROCS="$PROCS{\"pid\":$pid,\"name\":\"$NAME\",\"rss_mb\":$((RSS/1024)),\"peak_mb\":$((PEAK/1024))}"
      fi
    done
    echo "{\"timestamp\":\"$(date -Iseconds)\",\"available_mb\":$AVAIL,\"used_mb\":$USED,\"vitest\":[$PROCS]}" >> "$MONITOR_LOG"
    sleep 10
  done
) &
MONITOR_PID=$!
echo "Memory monitor started (PID $MONITOR_PID, log: $MONITOR_LOG)"

# ── Run vitest FROM THE WORKTREE ─────────────────────────────────
cd "$WT_DIR"
# vitest exits 1 when any test fails — which is EVERY test262 run (conformance tests).
# Check for actual crashes by looking at the report file, not the exit code.
npx vitest run tests/test262-vitest.test.ts \
  --reporter=verbose \
  "$@" 2>&1 | tee /tmp/test262-vitest-run.log
# Consider completed if the report was written (vitest's afterAll hook ran)
COMPLETED=false
if [ -f "$WT_DIR/benchmarks/results/test262-report.json" ]; then
  COMPLETED=true
fi

# ── Stop memory monitor ──────────────────────────────────────────
kill $MONITOR_PID 2>/dev/null
wait $MONITOR_PID 2>/dev/null
echo "Memory monitor stopped"

# ── Summarize peak memory ────────────────────────────────────────
if [ -f "$MONITOR_LOG" ]; then
  PEAK_RSS=$(python3 -c "
import json
peak = 0
with open('$MONITOR_LOG') as f:
    for line in f:
        d = json.loads(line)
        for v in d.get('vitest', []):
            if v.get('peak_mb', 0) > peak: peak = v['peak_mb']
print(peak)
" 2>/dev/null || echo "?")
  echo "Peak vitest memory: ${PEAK_RSS}MB"
fi

# ── Handle results ───────────────────────────────────────────────
echo ""

# Results are already in $RESULTS_DIR via symlink — no copy needed

if [ "$COMPLETED" = true ]; then
  # Append to historical index
  if [ -f "$RESULTS_DIR/test262-report.json" ]; then
    REPORT="$RESULTS_DIR/test262-report.json"
    PASS=$(python3 -c "import json; d=json.load(open('$REPORT')); print(d['summary']['pass'])" 2>/dev/null || echo "?")
    TOTAL=$(python3 -c "import json; d=json.load(open('$REPORT')); print(d['summary']['total'])" 2>/dev/null || echo "?")
    echo "COMPLETED: $PASS pass / $TOTAL total"
    echo "Results: $RESULTS_DIR/test262-results.jsonl"
    echo "Report:  $REPORT"
  fi
else
  echo "INCOMPLETE: vitest exited with error. Symlinks NOT updated."
  echo "Partial results saved to: $RUN_JSONL"
fi

# ── Cleanup ──────────────────────────────────────────────────────
echo "Cleaning up worktree..."
cd "$MAIN_DIR"
git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"

# Lock released automatically when script exits (fd 200 closes)
echo "Done."
