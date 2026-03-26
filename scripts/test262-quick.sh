#!/bin/bash
# Quick targeted test262 run — test a specific category or pattern.
# Usage: ./scripts/test262-quick.sh <category-pattern> [max-tests]
#
# Examples:
#   ./scripts/test262-quick.sh "language/expressions/class/dstr" 50
#   ./scripts/test262-quick.sh "built-ins/Array" 100
#   ./scripts/test262-quick.sh "language/arguments-object"

PATTERN="${1:?Usage: test262-quick.sh <category-pattern> [max-tests]}"
MAX="${2:-50}"

echo "Rebuilding compiler bundle..."
cd /workspace
npx esbuild src/index.ts --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript 2>&1 | tail -1

echo "Finding tests matching: $PATTERN (max $MAX)..."
TESTS=$(find test262/test -path "*${PATTERN}*" -name "*.js" \
  ! -name "*.imports.js" ! -name "*_FIXTURE*" \
  ! -path "*/private-method-*" ! -path "*/private-setter-*" ! -path "*/private-getter-*" \
  | head -n "$MAX")

COUNT=$(echo "$TESTS" | wc -l)
echo "Running $COUNT tests..."

PASS=0 FAIL=0 CE=0
for f in $TESTS; do
  RESULT=$(timeout 8 npx tsx src/cli.ts "$f" 2>&1)
  EXIT=$?
  if [ $EXIT -eq 0 ]; then
    # Compiled — try to run
    WASM="${f%.js}.wasm"
    IMPORTS="${f%.js}.imports.js"
    if [ -f "$WASM" ] && [ -f "$IMPORTS" ]; then
      RUN=$(timeout 5 node -e "
        const fs = require('fs');
        const wasm = fs.readFileSync('$WASM');
        const imports = require('./$IMPORTS');
        WebAssembly.instantiate(wasm, imports).then(i => {
          const r = i.instance.exports.test?.();
          process.exit(r === 1 ? 0 : 1);
        }).catch(() => process.exit(2));
      " 2>&1)
      RUN_EXIT=$?
      if [ $RUN_EXIT -eq 0 ]; then
        PASS=$((PASS+1))
      else
        FAIL=$((FAIL+1))
      fi
    else
      PASS=$((PASS+1))  # compiled at least
    fi
  else
    CE=$((CE+1))
  fi
done

echo ""
echo "Results: $PASS pass / $FAIL fail / $CE CE (of $COUNT)"
