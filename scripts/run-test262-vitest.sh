#!/bin/bash
# Run test262 via vitest in an isolated git worktree.
# Usage: ./scripts/run-test262-vitest.sh [vitest args...]
#
# Creates a temporary worktree from HEAD, symlinks heavy dirs,
# runs vitest, then copies results back to main workspace.

set -e

MAIN_DIR="/workspace"
WT_DIR="/tmp/ts2wasm-vitest-$$"
RESULTS_DIR="$MAIN_DIR/benchmarks/results"

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

# Share the disk cache (both directions benefit)
mkdir -p "$MAIN_DIR/.test262-cache"
ln -sf "$MAIN_DIR/.test262-cache" "$WT_DIR/.test262-cache"

# Ensure results dir exists in worktree
mkdir -p "$WT_DIR/benchmarks/results/runs"

echo "Worktree ready at $(git -C "$WT_DIR" rev-parse --short HEAD)"
echo "Running vitest..."

# Run vitest from worktree
cd "$WT_DIR"
npx vitest run tests/test262-vitest.test.ts \
  --pool=threads \
  --poolOptions.threads.maxThreads=${TEST262_WORKERS:-4} \
  --reporter=verbose \
  "$@" 2>&1 | tee /tmp/test262-vitest-run.log

# Copy results back to main workspace
echo ""
echo "Copying results to main workspace..."
cp -f "$WT_DIR/benchmarks/results/test262-results.jsonl" "$RESULTS_DIR/test262-results.jsonl" 2>/dev/null || true
cp -f "$WT_DIR/benchmarks/results/test262-report.json" "$RESULTS_DIR/test262-report.json" 2>/dev/null || true

# Copy run file if it exists
for f in "$WT_DIR"/benchmarks/results/runs/*.jsonl; do
  [ -f "$f" ] && cp -f "$f" "$RESULTS_DIR/runs/" 2>/dev/null
done

# Cleanup worktree
echo "Cleaning up worktree..."
cd "$MAIN_DIR"
git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"

echo "Done. Results in $RESULTS_DIR"
