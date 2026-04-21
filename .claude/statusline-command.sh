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

# bg_progress_bar pct label fill_bg empty_bg text_fg
# fill_bg/empty_bg/text_fg are ANSI color codes (e.g. 42, 100, 30)
bg_progress_bar() {
  awk -v pct="$1" -v label="$2" -v fill_bg="$3" -v empty_bg="$4" -v fg="$5" 'BEGIN {
    width = 12
    filled = int(pct * width / 100)
    bar = ""
    for (i = 0; i < width; i++) bar = bar " "
    bar = " " label substr(bar, length(label) + 2)
    filled_part = substr(bar, 1, filled)
    empty_part  = substr(bar, filled + 1)
    printf "\033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill_bg, fg, filled_part, empty_part
  }'
}

# Pass bar: green>=55%, yellow>=50%, red<50%
pass_bar() {
  awk -v p="$1" -v label="$2" 'BEGIN {
    if (p >= 55)      { fill=42; fg=30 }
    else if (p >= 50) { fill=43; fg=30 }
    else              { fill=41; fg=37 }
  }
  END {
    width = 12
    filled = int(p * width / 100)
    bar = ""
    for (i = 0; i < width; i++) bar = bar " "
    bar = " " label substr(bar, length(label) + 2)
    filled_part = substr(bar, 1, filled)
    empty_part  = substr(bar, filled + 1)
    printf "\033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
  }' /dev/null
}

# Free bar: green>=8G, yellow>=4G, red<4G (fills proportionally out of 16G)
free_bar() {
  awk -v free_g="$1" 'BEGIN {
    total_g = 16
    pct = free_g * 100 / total_g
    if (free_g >= 8)      { fill=42; fg=30 }
    else if (free_g >= 4) { fill=43; fg=30 }
    else                  { fill=41; fg=37 }
    width = 10
    filled = int(pct * width / 100)
    label = " " free_g "G free"
    bar = ""
    for (i = 0; i < width; i++) bar = bar " "
    bar = label substr(bar, length(label) + 1)
    filled_part = substr(bar, 1, filled)
    empty_part  = substr(bar, filled + 1)
    printf "\033[%s;%sm%s\033[48;5;237;37m%s\033[00m", fill, fg, filled_part, empty_part
  }'
}

if [ -n "$precompiling" ]; then
  done_n=$(wc -l < "$compile_jsonl" 2>/dev/null || echo 0)
  printf ' \033[00;33m⟳compile:%s/48K\033[00m' "$done_n"
elif [ -n "$vitesting" ]; then
  jsonl=$(ls -t /workspace/benchmarks/results/test262-results-*.jsonl 2>/dev/null | head -1)
  [ -z "$jsonl" ] && jsonl="/workspace/benchmarks/results/test262-results.jsonl"
  if [ -f "$jsonl" ]; then
    pass=$(grep -c '"pass"' "$jsonl" 2>/dev/null || echo 0)
    total=$(wc -l < "$jsonl" 2>/dev/null || echo 0)
    if [ "$total" -gt 0 ]; then
      expected=$(jq -r '.summary.total // 48088' "$report" 2>/dev/null)
      pct=$((total * 100 / expected))
      pass_pct=$(awk "BEGIN {printf \"%.1f\", $pass * 100 / $total}")
      free_mb=$(free -m | awk '/Mem/{print $7}')
      free_g=$(awk "BEGIN {printf \"%.0f\", $free_mb / 1024}")
      # ETA from timestamp in filename
      eta_label="${pct}%"
      start_ts=$(echo "$jsonl" | grep -oE '[0-9]{8}-[0-9]{6}' | head -1)
      if [ -n "$start_ts" ]; then
        start_sec=$(echo "$start_ts" | awk -F'-' '{
          d=$1; t=$2
          fmt=d " " substr(t,1,2) ":" substr(t,3,2) ":" substr(t,5,2)
          cmd="date -d \""fmt"\" +%s"
          cmd | getline s; close(cmd); print s
        }' 2>/dev/null)
        now_sec=$(date +%s)
        elapsed=$((now_sec - start_sec))
        if [ "$elapsed" -gt 5 ] && [ "$total" -gt 0 ]; then
          remaining=$((expected - total))
          eta_sec=$((remaining * elapsed / total))
          if [ "$eta_sec" -lt 60 ]; then
            eta_label="${eta_sec}s left"
          else
            eta_label="$((eta_sec / 60))m left"
          fi
        fi
      fi
      p_bar=$(pass_bar "$pass_pct" "${pass_pct}% pass")
      d_bar=$(bg_progress_bar "$pct" "$eta_label" 42 100 30)
      f_bar=$(free_bar "$free_g")
      printf ' \033[00;33m⟳t262\033[00m | %s | %s | %s' "$p_bar" "$d_bar" "$f_bar"
    else
      printf ' \033[00;33m⟳t262:starting\033[00m'
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
  p_bar=$(pass_bar "$pass_pct" "${pass_pct}% pass")
  f_bar=$(free_bar "$free_g")
  printf ' \033[00;33m⟳t262\033[00m | %s | %s' "$p_bar" "$f_bar"
fi
printf '\n'
