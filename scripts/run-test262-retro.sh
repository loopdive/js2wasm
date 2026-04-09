#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_ROOT="$ROOT_DIR/benchmarks/results/retro"

mkdir -p "$OUTPUT_ROOT"

FROM_DATE="${FROM_DATE:-}"
TO_DATE="${TO_DATE:-}"
LIMIT_DAYS="${LIMIT_DAYS:-}"

CURRENT_HARNESS_FILES=(
  "src/runtime.ts"
  "tests/test262-runner.ts"
  "tests/test262-shared.ts"
  "tests/test262-vitest.test.ts"
  "scripts/compiler-pool.ts"
  "scripts/test262-worker.mjs"
  "scripts/compiler-fork-worker.mjs"
  "scripts/run-test262-vitest.sh"
)

copy_current_harness() {
  local wt="$1"

  mkdir -p "$wt/tests" "$wt/scripts"
  for file in "${CURRENT_HARNESS_FILES[@]}"; do
    mkdir -p "$wt/$(dirname "$file")"
    cp "$ROOT_DIR/$file" "$wt/$file"
  done

  rm -f "$wt/tests"/test262-chunk*.test.ts
  cp "$ROOT_DIR"/tests/test262-chunk*.test.ts "$wt/tests/"
}

daily_commits() {
  git -C "$ROOT_DIR" log --reverse --date=short --format='%ad %H' | awk '
    BEGIN { prevDay = ""; last = "" }
    {
      day = $1;
      if (prevDay != "" && day != prevDay) print last;
      prevDay = day;
      last = $0;
    }
    END {
      if (last != "") print last;
    }
  '
}

run_one() {
  local day="$1"
  local commit="$2"
  local short="${commit:0:8}"
  local wt="/tmp/js2wasm-retro-${day//-/}-${short}-$$"
  local out_dir="$OUTPUT_ROOT/${day}-${short}"

  mkdir -p "$out_dir"

  echo "==> [$day] $commit"
  git -C "$ROOT_DIR" worktree add "$wt" "$commit" --detach --quiet
  trap 'git -C "$ROOT_DIR" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"' RETURN

  rm -rf "$wt/node_modules" "$wt/test262"
  ln -s "$ROOT_DIR/node_modules" "$wt/node_modules"
  ln -s "$ROOT_DIR/test262" "$wt/test262"

  mkdir -p "$wt/benchmarks"
  rm -rf "$wt/benchmarks/results"
  ln -s "$out_dir" "$wt/benchmarks/results"

  copy_current_harness "$wt"

  (
    cd "$wt"
    bash scripts/run-test262-vitest.sh --include-proposals
  )

  local latest_report
  latest_report="$(find "$out_dir" -maxdepth 1 -name 'test262-report-*.json' | sort | tail -n 1)"
  local latest_jsonl
  latest_jsonl="$(find "$out_dir" -maxdepth 1 -name 'test262-results-*.jsonl' | sort | tail -n 1)"

  node -e "
const fs = require('fs');
const reportPath = process.argv[1];
const jsonlPath = process.argv[2];
const outPath = process.argv[3];
const day = process.argv[4];
const commit = process.argv[5];
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const counts = {
  strictOnly: { total: 0, pass: 0 },
  legacyOnly: { total: 0, pass: 0 },
  proposal: { total: 0, pass: 0 },
};
const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
for (const line of lines) {
  const row = JSON.parse(line);
  const status = row.status;
  const isPass = status === 'pass';
  const isTerminal = ['pass', 'fail', 'compile_error', 'compile_timeout', 'skip'].includes(status);
  if (!isTerminal) continue;
  if (row.scope === 'proposal') {
    counts.proposal.total++;
    if (isPass) counts.proposal.pass++;
  }
  if (row.strict === 'no') {
    counts.legacyOnly.total++;
    if (isPass) counts.legacyOnly.pass++;
  }
  if (row.strict === 'only' || row.strict === 'both') {
    counts.strictOnly.total++;
    if (isPass) counts.strictOnly.pass++;
  }
}
const payload = {
  day,
  commit,
  report_path: reportPath,
  results_path: jsonlPath,
  summary: report.summary,
  official_summary: report.official_summary ?? null,
  full_summary: report.full_summary ?? null,
  strict_summary: report.strict_summary ?? null,
  scope_summaries: report.scope_summaries ?? null,
  derived: counts,
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
" "$latest_report" "$latest_jsonl" "$out_dir/retro-summary.json" "$day" "$commit"

  git -C "$ROOT_DIR" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
  trap - RETURN
}

filtered=()
while IFS= read -r row; do
  day="${row%% *}"
  commit="${row##* }"
  if [[ -n "$FROM_DATE" && "$day" < "$FROM_DATE" ]]; then
    continue
  fi
  if [[ -n "$TO_DATE" && "$day" > "$TO_DATE" ]]; then
    continue
  fi
  filtered+=("$day $commit")
done < <(daily_commits)

if [[ -n "$LIMIT_DAYS" ]]; then
  filtered=("${filtered[@]:0:$LIMIT_DAYS}")
fi

echo "Running retrospective test262 for ${#filtered[@]} day(s)"
for row in "${filtered[@]}"; do
  run_one "${row%% *}" "${row##* }"
done
