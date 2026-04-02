#!/bin/bash
# Run test262 via vitest in an isolated git worktree.
# Usage: pnpm run test:262 [vitest args...]
#
# - Uses flock to prevent parallel runs (only one test262 at a time)
# - Writes results to timestamped files, updates symlink only on completion
# - Builds compiler bundle from the worktree (not /workspace)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCKFILE="/tmp/js2wasm-test262.lock"
LOCKDIR="/tmp/js2wasm-test262.lockdir"
RESULTS_DIR="$MAIN_DIR/benchmarks/results"
RUN_TIMESTAMP=$(date +%Y%m%d-%H%M%S)
INCLUDE_PROPOSALS=0

forwarded_args=()
for arg in "$@"; do
  if [ "$arg" = "--include-proposals" ]; then
    INCLUDE_PROPOSALS=1
  else
    forwarded_args+=("$arg")
  fi
done
export TEST262_INCLUDE_PROPOSALS="$INCLUDE_PROPOSALS"

resolve_esbuild() {
  if [ -n "${ESBUILD_BIN:-}" ] && [ -x "${ESBUILD_BIN:-}" ]; then
    echo "$ESBUILD_BIN"
    return 0
  fi
  if command -v esbuild >/dev/null 2>&1; then
    command -v esbuild
    return 0
  fi
  if [ -x "$MAIN_DIR/node_modules/.bin/esbuild" ]; then
    echo "$MAIN_DIR/node_modules/.bin/esbuild"
    return 0
  fi
  local candidate
  candidate=$(find "$MAIN_DIR/node_modules/.pnpm" -path '*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null | head -n 1)
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    echo "$candidate"
    return 0
  fi
  return 1
}

cleanup_lock() {
  if [ -d "$LOCKDIR" ]; then
    rm -rf "$LOCKDIR"
  fi
}

cleanup_worktree() {
  if [ "${USE_WORKTREE:-0}" != "1" ]; then
    return
  fi
  echo "Cleaning up worktree..."
  cd "$MAIN_DIR"
  git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"
}

cleanup() {
  if [ -n "${MONITOR_PID:-}" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
  fi
  if [ -n "${WT_DIR:-}" ] && [ -e "${WT_DIR:-}" ]; then
    cleanup_worktree
  fi
  cleanup_lock
}

trap cleanup EXIT

# ── Exclusive lock — only one test262 run at a time ──────────────
if command -v flock >/dev/null 2>&1; then
  exec 200>"$LOCKFILE"
  if ! flock -n 200; then
    echo "ERROR: Another test262 run is in progress (lock held: $LOCKFILE)"
    echo "Wait for it to finish or kill the process holding the lock."
    exit 1
  fi
else
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo "$$" > "$LOCKFILE"
  else
    LOCK_PID=""
    if [ -f "$LOCKFILE" ]; then
      LOCK_PID="$(cat "$LOCKFILE" 2>/dev/null || true)"
    fi
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
      echo "ERROR: Another test262 run is in progress (pid $LOCK_PID)"
      echo "Wait for it to finish or remove the stale lock: $LOCKDIR"
      exit 1
    fi
    rm -rf "$LOCKDIR"
    rm -f "$LOCKFILE"
    mkdir "$LOCKDIR"
    echo "$$" > "$LOCKFILE"
  fi
fi
echo "Lock acquired (PID $$)"

# ── Create isolated worktree ─────────────────────────────────────
WT_DIR="/tmp/js2wasm-vitest-$$"
USE_WORKTREE=1
echo "Creating worktree at $WT_DIR ..."
if ! git -C "$MAIN_DIR" worktree add "$WT_DIR" HEAD --detach --quiet 2>/dev/null; then
  echo "Worktree creation failed; falling back to current workspace"
  WT_DIR="$MAIN_DIR"
  USE_WORKTREE=0
fi

# Symlink heavy directories to avoid duplication
if [ "$USE_WORKTREE" = "1" ]; then
  rm -rf "$WT_DIR/node_modules" "$WT_DIR/test262"
  ln -s "$MAIN_DIR/node_modules" "$WT_DIR/node_modules"
  ln -s "$MAIN_DIR/test262" "$WT_DIR/test262"
fi

# Verify symlinks
if [ ! -d "$WT_DIR/test262/test" ]; then
  echo "ERROR: test262 symlink failed"
  exit 1
fi
echo "test262 symlink OK ($(ls "$WT_DIR/test262/test/" | wc -l) dirs)"

# Share the disk cache
mkdir -p "$MAIN_DIR/.test262-cache"
if [ "$USE_WORKTREE" = "1" ]; then
  ln -sf "$MAIN_DIR/.test262-cache" "$WT_DIR/.test262-cache"
fi

# ── Build compiler bundle FROM THE WORKTREE (not /workspace) ─────
echo "Building compiler bundle in worktree..."
cd "$WT_DIR"
ESBUILD_BIN="$(resolve_esbuild || true)"
if [ -z "$ESBUILD_BIN" ]; then
  echo "ERROR: esbuild not found (checked PATH, node_modules/.bin, pnpm store)"
  exit 1
fi
"$ESBUILD_BIN" src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript 2>&1 | tail -1
"$ESBUILD_BIN" src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs --external:typescript 2>&1 | tail -1

# ── Prepare result files ─────────────────────────────────────────
# Vitest writes to timestamped test262-results-YYYYMMDD-HHMMSS.jsonl directly.
# RUN_TIMESTAMP env var tells test262-shared.ts which filename to use.
export RUN_TIMESTAMP

# Symlink worktree results dir to main workspace (results survive cleanup)
if [ "$USE_WORKTREE" = "1" ]; then
  rm -rf "$WT_DIR/benchmarks/results"
  ln -s "$RESULTS_DIR" "$WT_DIR/benchmarks/results"
fi

echo "Run ID: $RUN_TIMESTAMP"
echo "Worktree at $(git -C "$WT_DIR" rev-parse --short HEAD)"
echo "Running vitest (unified compile+execute in fork pool)..."

# ── Start memory monitor ─────────────────────────────────────────
MONITOR_LOG="$RESULTS_DIR/memory-monitor-${RUN_TIMESTAMP}.jsonl"
MONITOR_PID=""
if command -v free >/dev/null 2>&1 && [ -d /proc ]; then
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
else
  echo "Memory monitor skipped: unsupported platform"
fi

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
    "${forwarded_args[@]}" 2>&1 | tee /tmp/test262-vitest-run.log || true
else
  # Single file mode: run the monolithic test file
  echo "Running single test file..."
  npx vitest run tests/test262-vitest.test.ts \
    --reporter=verbose \
    "${forwarded_args[@]}" 2>&1 | tee /tmp/test262-vitest-run.log || true
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
official_statuses = Counter()
cats = {}
errors = Counter()
skips = Counter()
scope_counts = {
    'standard': Counter(),
    'annex_b': Counter(),
    'proposal': Counter(),
}

with open('$JSONL_FILE') as f:
    for line in f:
        r = json.loads(line)
        s = r['status']
        statuses[s] += 1
        scope = r.get('scope', 'standard')
        scope_counts.setdefault(scope, Counter())
        scope_counts[scope][s] += 1
        if r.get('scope_official', scope != 'proposal'):
            official_statuses[s] += 1
        cat = r.get('category', 'unknown')
        if cat not in cats:
            cats[cat] = {'pass': 0, 'fail': 0, 'compile_error': 0, 'compile_timeout': 0, 'skip': 0, 'total': 0}
        cats[cat][s] = cats[cat].get(s, 0) + 1
        cats[cat]['total'] += 1
        if r.get('error_category'):
            errors[r['error_category']] += 1
        if s == 'skip' and r.get('error'):
            skips[r['error']] += 1

def build_summary(counter):
    return {
        'total': sum(counter.values()),
        'pass': counter.get('pass', 0),
        'fail': counter.get('fail', 0),
        'compile_error': counter.get('compile_error', 0),
        'compile_timeout': counter.get('compile_timeout', 0),
        'skip': counter.get('skip', 0),
        'compilable': counter.get('pass', 0) + counter.get('fail', 0),
        'stale': 0,
    }

report = {
    'timestamp': '$(date -Iseconds)',
    'mode': {
        'include_proposals': ${INCLUDE_PROPOSALS},
        'label': 'full test262' if ${INCLUDE_PROPOSALS} else 'official test262 (default scope)',
    },
    'summary': build_summary(official_statuses),
    'official_summary': build_summary(official_statuses),
    'full_summary': build_summary(statuses),
    'scope_summaries': {name: build_summary(counter) for name, counter in sorted(scope_counts.items())},
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
if [ -n "$MONITOR_PID" ]; then
  kill "$MONITOR_PID" 2>/dev/null || true
  wait "$MONITOR_PID" 2>/dev/null || true
  echo "Memory monitor stopped"
fi

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
    RUNS_DIR="$RESULTS_DIR/runs"
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
    'ce': report['summary'].get('compile_error', 0),
    'skip': report['summary'].get('skip', 0),
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
echo "Done."
