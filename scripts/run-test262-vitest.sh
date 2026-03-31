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

# ── Prepare result files ─────────────────────────────────────────
# Vitest writes to timestamped test262-results-YYYYMMDD-HHMMSS.jsonl directly.
# RUN_TIMESTAMP env var tells test262-shared.ts which filename to use.
export RUN_TIMESTAMP

# Symlink worktree results dir to main workspace (results survive cleanup)
rm -rf "$WT_DIR/benchmarks/results"
ln -s "$RESULTS_DIR" "$WT_DIR/benchmarks/results"

echo "Run ID: $RUN_TIMESTAMP"
echo "Worktree at $(git -C "$WT_DIR" rev-parse --short HEAD)"
echo "Running vitest (unified compile+execute in fork pool)..."

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

# ── Run vitest chunk-by-chunk FROM THE WORKTREE ─────────────────
# 1 fork per chunk, fork dies between chunks → memory fully freed.
# Fork uses nproc compiler threads for max CPU utilization.
cd "$WT_DIR"
CHUNKS=$(ls tests/test262-chunk*.test.ts 2>/dev/null | sort)
> /tmp/test262-vitest-run.log

if [ -n "$CHUNKS" ]; then
  # Run all chunk files in a single vitest invocation — vitest parallelizes across forks
  CHUNK_COUNT=$(echo "$CHUNKS" | wc -l)
  echo "Running $CHUNK_COUNT chunk files in one vitest invocation..."
  npx vitest run tests/test262-chunk*.test.ts \
    --reporter=verbose \
    "$@" 2>&1 | tee /tmp/test262-vitest-run.log || true
else
  # Single file mode: run the monolithic test file
  echo "Running single test file..."
  npx vitest run tests/test262-vitest.test.ts \
    --reporter=verbose \
    "$@" 2>&1 | tee /tmp/test262-vitest-run.log || true
fi
# Generate report.json from JSONL (atomic — no fork race condition)
JSONL_FILE="$RESULTS_DIR/test262-results-${RUN_TIMESTAMP}.jsonl"
REPORT_FILE="$RESULTS_DIR/test262-report-${RUN_TIMESTAMP}.json"
COMPLETED=false
if [ -f "$JSONL_FILE" ] && [ -s "$JSONL_FILE" ]; then
  python3 -c "
import json
from collections import Counter

statuses = Counter()
cats = {}
errors = Counter()
skips = Counter()

with open('$JSONL_FILE') as f:
    for line in f:
        r = json.loads(line)
        s = r['status']
        statuses[s] += 1
        cat = r.get('category', 'unknown')
        if cat not in cats:
            cats[cat] = {'pass': 0, 'fail': 0, 'compile_error': 0, 'skip': 0, 'total': 0}
        cats[cat][s] = cats[cat].get(s, 0) + 1
        cats[cat]['total'] += 1
        if r.get('error_category'):
            errors[r['error_category']] += 1
        if s == 'skip' and r.get('error'):
            skips[r['error']] += 1

report = {
    'timestamp': '$(date -Iseconds)',
    'summary': {
        'total': sum(statuses.values()),
        'pass': statuses.get('pass', 0),
        'fail': statuses.get('fail', 0),
        'compile_error': statuses.get('compile_error', 0),
        'compile_timeout': statuses.get('compile_timeout', 0),
        'skip': statuses.get('skip', 0),
        'compilable': statuses.get('pass', 0) + statuses.get('fail', 0),
        'stale': 0,
    },
    'categories': [{'name': n, **c} for n, c in sorted(cats.items())],
    'error_categories': dict(errors),
    'skip_reasons': dict(skips),
}

with open('$REPORT_FILE', 'w') as f:
    json.dump(report, f, indent=2)

s = report['summary']
print('Report: %d pass / %d total (%.1f%%)' % (s['pass'], s['total'], s['pass']/s['total']*100))
" && COMPLETED=true
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

# Files are already timestamped (vitest writes to test262-results-${RUN_TIMESTAMP}.jsonl)
RUN_REPORT="$RESULTS_DIR/test262-report-${RUN_TIMESTAMP}.json"
RUN_JSONL="$RESULTS_DIR/test262-results-${RUN_TIMESTAMP}.jsonl"

if [ "$COMPLETED" = true ]; then
  # Update symlinks to point to latest timestamped files
  ln -sf "$(basename "$RUN_REPORT")" "$RESULTS_DIR/test262-report.json"
  ln -sf "$(basename "$RUN_JSONL")" "$RESULTS_DIR/test262-results.jsonl"

  PASS=$(python3 -c "import json; d=json.load(open('$RUN_REPORT')); print(d['summary']['pass'])" 2>/dev/null || echo "?")
  TOTAL=$(python3 -c "import json; d=json.load(open('$RUN_REPORT')); print(d['summary']['total'])" 2>/dev/null || echo "?")
  echo "COMPLETED: $PASS pass / $TOTAL total"
  echo "Report:  $RUN_REPORT"
  echo "Results: $RUN_JSONL"
  echo "Symlinks updated."

  # Append to historical index
  if [ -f "$RUN_REPORT" ]; then
    RUNS_DIR="$MAIN_DIR/runs"
    mkdir -p "$RUNS_DIR"
    INDEX_FILE="$RUNS_DIR/index.json"
    if [ ! -f "$INDEX_FILE" ]; then echo '[]' > "$INDEX_FILE"; fi
    python3 -c "
import json, sys
with open('$RUN_REPORT') as f: report = json.load(f)
entry = {
    'timestamp': '$RUN_TIMESTAMP',
    'pass': report['summary']['pass'],
    'fail': report['summary']['fail'],
    'compile_error': report['summary'].get('compile_error', 0),
    'total': report['summary']['total'],
}
with open('$INDEX_FILE') as f: idx = json.load(f)
idx.append(entry)
with open('$INDEX_FILE', 'w') as f: json.dump(idx, f, indent=2)
print('Appended to index: %d pass / %d total' % (entry['pass'], entry['total']))
" 2>/dev/null || echo "Warning: failed to update historical index"
  fi
else
  echo "INCOMPLETE: Report generation failed or no results."
  echo "Check /tmp/test262-vitest-run.log for errors."
fi

# ── Cleanup ──────────────────────────────────────────────────────
echo "Cleaning up worktree..."
cd "$MAIN_DIR"
git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"

# Lock released automatically when script exits (fd 200 closes)
echo "Done."
