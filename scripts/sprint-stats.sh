#!/usr/bin/env bash
# Derive sprint statistics from git tags.
# Output: JSON array for dashboard consumption.
# Tags: sprint/N (N = sprint number, tag commit = sprint end)
# Duration: time between previous tag and this tag
# Date: completion date/time from tag commit

set -euo pipefail

CURRENT_YEAR=$(date +%Y)
OUTPUT="${1:-/workspace/dashboard/data/sprint-stats.json}"

tags=$(git tag -l "sprint/*" --sort=version:refname)
prev_epoch=""
prev_tag=""

echo "["

first=true
for tag in $tags; do
  num="${tag#sprint/}"

  # Get commit date
  commit_date=$(git log -1 --format="%ci" "$tag")
  epoch=$(git log -1 --format="%ct" "$tag")

  # Format date: without year if current year
  year=$(echo "$commit_date" | cut -d- -f1)
  month=$(echo "$commit_date" | cut -d- -f2 | sed 's/^0//')
  day=$(echo "$commit_date" | cut -d- -f3 | cut -d' ' -f1 | sed 's/^0//')
  time=$(echo "$commit_date" | cut -d' ' -f2 | cut -d: -f1-2)

  if [ "$year" = "$CURRENT_YEAR" ]; then
    date_str="${day}.${month}. ${time}"
  else
    date_str="${day}.${month}.${year} ${time}"
  fi

  # Duration from previous tag
  duration=""
  if [ -n "$prev_epoch" ]; then
    diff_secs=$((epoch - prev_epoch))
    if [ "$diff_secs" -lt 0 ]; then
      diff_secs=$((-diff_secs))
    fi
    hours=$((diff_secs / 3600))
    if [ "$hours" -lt 1 ]; then
      mins=$((diff_secs / 60))
      duration="${mins}m"
    elif [ "$hours" -lt 24 ]; then
      remainder=$(( (diff_secs % 3600) / 60 ))
      if [ "$remainder" -gt 0 ]; then
        duration="${hours}h ${remainder}m"
      else
        duration="${hours}h"
      fi
    else
      days=$((hours / 24))
      rem_hours=$((hours % 24))
      if [ "$rem_hours" -gt 0 ]; then
        duration="${days}d ${rem_hours}h"
      else
        duration="${days}d"
      fi
    fi
  fi

  # Count commits between tags
  if [ -n "$prev_tag" ]; then
    commits=$(git rev-list --count "${prev_tag}..${tag}")
  else
    commits=$(git rev-list --count "$tag")
  fi

  if [ "$first" = true ]; then
    first=false
  else
    echo ","
  fi

  printf '  {"sprint": %s, "date": "%s", "duration": "%s", "commits": %s}' \
    "$num" "$date_str" "$duration" "$commits"

  prev_epoch="$epoch"
  prev_tag="$tag"
done

echo ""
echo "]"
