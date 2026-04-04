#!/bin/bash
# Test-and-merge script — replaces tester agents to save tokens.
# Usage: bash scripts/test-and-merge.sh <branch-name> [baseline-pass-count]
#
# 1. Builds compiler from the branch's worktree
# 2. Merges main into the branch
# 3. Runs equivalence tests
# 4. Runs full test262
# 5. Compares pass count against baseline
# 6. If no regression: creates merge proof and ff-only merges to main
# 7. If regression: reports failure and does NOT merge

set -euo pipefail

BRANCH="${1:?Usage: test-and-merge.sh <branch-name> [baseline-pass-count]}"
BASELINE="${2:-16268}"

# Find worktree for this branch
WT=""
for wt in /workspace/.claude/worktrees/*; do
  if [ -d "$wt" ] && git -C "$wt" branch --show-current 2>/dev/null | grep -q "$BRANCH"; then
    WT="$wt"
    break
  fi
done

if [ -z "$WT" ]; then
  echo "ERROR: No worktree found for branch $BRANCH"
  exit 1
fi

echo "=== Testing branch: $BRANCH ==="
echo "Worktree: $WT"
echo "Baseline: $BASELINE pass"

# Merge main into branch
echo "Merging main into branch..."
git -C "$WT" merge main --no-edit || { echo "MERGE CONFLICT — fix manually"; exit 1; }

# Build from branch source
echo "Building compiler from branch..."
/workspace/node_modules/.bin/esbuild "$WT/src/index.ts" --bundle --platform=node --format=esm \
  --outfile=/workspace/scripts/compiler-bundle.mjs --external:typescript --external:binaryen
/workspace/node_modules/.bin/esbuild "$WT/src/runtime.ts" --bundle --platform=node --format=esm \
  --outfile=/workspace/scripts/runtime-bundle.mjs --external:typescript --external:binaryen

# Run equivalence tests
echo "Running equivalence tests..."
cd /workspace
EQUIV_RESULT=$(node node_modules/vitest/dist/cli.js run tests/equivalence/ 2>&1 | tail -3)
echo "$EQUIV_RESULT"

# Run test262
echo "Running test262..."
pnpm run test:262

# Find latest report
REPORT=$(ls -t /workspace/benchmarks/results/test262-report-*.json 2>/dev/null | head -1)
if [ -z "$REPORT" ]; then
  echo "ERROR: No test262 report found"
  exit 1
fi

PASS=$(python3 -c "import json; print(json.load(open('$REPORT'))['summary']['pass'])")
echo "=== Result: $PASS pass (baseline: $BASELINE) ==="

if [ "$PASS" -lt "$BASELINE" ]; then
  DELTA=$((PASS - BASELINE))
  echo "REGRESSION: $DELTA pass. DO NOT MERGE."
  echo "Run: npx tsx scripts/diff-test262.ts <baseline.jsonl> <new.jsonl>"
  exit 1
fi

# Create merge proof
mkdir -p /workspace/.claude/nonces
cat > /workspace/.claude/nonces/merge-proof.json << EOF
{"branch":"$BRANCH","equiv_passed":true,"test262_pass":$PASS,"timestamp":"$(date -Iseconds)","result":"no_regression"}
EOF

# Merge to main
echo "Merging to main..."
cd /workspace
git merge --ff-only "$BRANCH" || { echo "FF-ONLY FAILED — branch diverged from main"; exit 1; }

echo "=== MERGED: $BRANCH → main ($PASS pass, +$((PASS - BASELINE)) from baseline) ==="
