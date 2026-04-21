#!/bin/sh
input=$(cat)
cwd=$(echo "$input" | jq -r '.cwd // .workspace.current_dir // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
printf '\033[01;34m%s\033[00m' "${cwd:-$(pwd)}"
[ -n "$used" ] && printf ' \033[00;36mctx:%s%%\033[00m' "$(printf '%.0f' "$used")"
# Test262 progress
report="/workspace/benchmarks/results/test262-report.json"
compile_jsonl="/workspace/benchmarks/results/test262-compile.jsonl"
precompiling=$(ps aux 2>/dev/null | grep '[p]recompile-tests' | head -1)
vitesting=$(ps aux 2>/dev/null | grep '[v]itest.*test262\|vitest [0-9]\|run-test262-vitest' | head -1)
if [ -n "$precompiling" ]; then
  done=$(wc -l < "$compile_jsonl" 2>/dev/null || echo 0)
  printf ' \033[00;33m⟳compile:%s/48K\033[00m' "$done"
elif [ -n "$vitesting" ]; then
  # Prefer the in-progress timestamped file (runner only updates symlink after completion)
  jsonl=$(ls -t /workspace/benchmarks/results/test262-results-*.jsonl 2>/dev/null | head -1)
  [ -z "$jsonl" ] && jsonl="/workspace/benchmarks/results/test262-results.jsonl"
  if [ -f "$jsonl" ]; then
    pass=$(grep -c '"pass"' "$jsonl" 2>/dev/null || echo 0)
    total=$(wc -l < "$jsonl" 2>/dev/null || echo 0)
    if [ "$total" -gt 0 ]; then
      expected=$(jq -r '.summary.total // 48088' "$report" 2>/dev/null)
      pct=$((total * 100 / expected))
      pass_pct=$(awk "BEGIN {printf \"%.1f\", $pass * 100 / $expected}")
      free_mb=$(free -m | awk '/Mem/{print $7}')
      free_g=$(awk "BEGIN {printf \"%.0f\", $free_mb / 1024}")
      printf ' \033[00;33m⟳t262:%s%% done pass:%s%% free:%sG\033[00m' "$pct" "$pass_pct" "$free_g"
    else
      printf ' \033[00;33m⟳t262:0%%\033[00m'
    fi
  else
    printf ' \033[00;33m⟳t262:starting\033[00m'
  fi
elif [ -f "$report" ]; then
  pass=$(jq -r '.summary.pass // 0' "$report" 2>/dev/null)
  total=$(jq -r '.summary.total // 1' "$report" 2>/dev/null)
  pass_pct=$(awk "BEGIN {printf \"%.1f\", $pass * 100 / $total}")
  free_mb=$(free -m | awk '/Mem/{print $7}')
  free_g=$(awk "BEGIN {printf \"%.0f\", $free_mb / 1024}")
  printf ' \033[00;35mt262:%s%% pass free:%sG\033[00m' "$pass_pct" "$free_g"
fi
printf '\n'
