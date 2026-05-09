#!/usr/bin/env bash
# Fetch the ECMAScript spec (tc39.es/ecma262) to .local/ecma262/
# Gitignored locally. For persistent storage use the js2wasm-labs labs/spec branch.
#
# Usage:
#   ./scripts/fetch-ecma262.sh             # download to .local/ecma262/
#   ./scripts/fetch-ecma262.sh --push-labs  # also push to js2wasm-labs labs/spec
#
# Agents can read the spec with:
#   grep -n "AbstractRelationalComparison\|SameValueZero" .local/ecma262/index.html
#   Read .local/ecma262/index.html (then search by section heading)

set -euo pipefail

DEST=".local/ecma262"
SPEC_URL="https://tc39.es/ecma262/"

mkdir -p "$DEST"

echo "Fetching ECMAScript spec from $SPEC_URL ..."
curl -L --compressed -o "$DEST/index.html" "$SPEC_URL"

SIZE=$(du -sh "$DEST/index.html" | cut -f1)
echo "Saved to $DEST/index.html ($SIZE)"

# Quick sanity check
if grep -q "ECMAScript" "$DEST/index.html"; then
  YEAR=$(grep -o 'ECMAScript [0-9]\+' "$DEST/index.html" | head -1)
  echo "Verified: $YEAR spec"
else
  echo "Warning: file doesn't look like the ECMAScript spec" >&2
  exit 1
fi

if [[ "${1:-}" == "--push-labs" ]]; then
  echo ""
  echo "Pushing to js2wasm-labs labs/spec branch..."
  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT

  git clone --depth=1 git@github.com:loopdive/js2wasm-labs.git "$TMPDIR/labs"
  cd "$TMPDIR/labs"

  git checkout --orphan labs/spec 2>/dev/null || git checkout labs/spec
  git rm -rf . --quiet 2>/dev/null || true

  cp "$OLDPWD/$DEST/index.html" ./ecma262.html
  echo "# ECMAScript Spec Mirror" > README.md
  echo "" >> README.md
  echo "Fetched from $SPEC_URL on $(date -u +%Y-%m-%d). Single-file HTML." >> README.md
  echo "Refresh by running \`./scripts/fetch-ecma262.sh --push-labs\` from js2wasm." >> README.md

  git add ecma262.html README.md
  git commit -m "chore(spec): refresh ECMAScript spec $(date -u +%Y-%m-%d)"
  git push origin labs/spec --force
  echo "Pushed to loopdive/js2wasm-labs:labs/spec"
fi
