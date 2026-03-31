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
  jsonl="/workspace/benchmarks/results/test262-results.jsonl"
  if [ -f "$jsonl" ]; then
    pass=$(grep -c '"pass"' "$jsonl" 2>/dev/null || echo 0)
    total=$(wc -l < "$jsonl" 2>/dev/null || echo 0)
    if [ "$total" -gt 0 ]; then
      pct=$((total * 100 / 48088))
      test_mb=$(ps aux | grep '[v]itest' | awk '{sum+=$6} END {printf "%d", sum/1024}')
      free_mb=$(free -m | awk '/Mem/{print $7}')
      printf ' \033[00;33m⟳t262:%s%% p:%s t:%sMB free:%sMB\033[00m' "$pct" "$pass" "$test_mb" "$free_mb"
    else
      printf ' \033[00;33m⟳t262:0%%\033[00m'
    fi
  else
    printf ' \033[00;33m⟳t262:starting\033[00m'
  fi
elif [ -f "$report" ]; then
  pass=$(jq -r '.summary.pass // 0' "$report" 2>/dev/null)
  total=$(jq -r '.summary.total // 0' "$report" 2>/dev/null)
  ce=$(jq -r '.summary.compile_error // 0' "$report" 2>/dev/null)
  printf ' \033[00;35mt262:%s/%s CE:%s\033[00m' "$pass" "$total" "$ce"
fi
printf '\n'
