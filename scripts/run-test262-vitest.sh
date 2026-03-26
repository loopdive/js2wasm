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

# Build compiler bundle in worktree (needed by compiler workers)
echo "Building compiler bundle..."
cd "$WT_DIR"
npx esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript 2>&1 | tail -1

# Symlink results dir so writes go directly to main workspace
rm -rf "$WT_DIR/benchmarks/results"
ln -s "$MAIN_DIR/benchmarks/results" "$WT_DIR/benchmarks/results"

echo "Worktree ready at $(git -C "$WT_DIR" rev-parse --short HEAD)"
echo "Running vitest..."

# Always rebuild main workspace bundle from current source to avoid stale-bundle bugs
echo "Rebuilding main bundle..."
cd "$MAIN_DIR"
npx esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript 2>&1 | tail -1

# Run vitest from main workspace (vitest 4.x needs real node_modules, not symlinks)
npx vitest run tests/test262-vitest.test.ts \
  --reporter=verbose \
  "$@" 2>&1 | tee /tmp/test262-vitest-run.log

# Results already written directly to main workspace via symlink
echo ""
echo "Results written to $RESULTS_DIR"

# Cleanup worktree
echo "Cleaning up worktree..."
cd "$MAIN_DIR"
git worktree remove --force "$WT_DIR" 2>/dev/null || rm -rf "$WT_DIR"

echo "Done. Results in $RESULTS_DIR"
