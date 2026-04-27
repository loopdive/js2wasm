---
name: merge-wave
description: Triage N open PRs with sharded test262 results, rank by net pass delta, merge winners, close catastrophes. Use when multiple PRs have completed CI and you want to land a batch.
---

# Merge Wave Protocol

Triage every open PR that has finished sharded test262 CI, compute its real net delta, and execute a ranked merge order in one pass.

## When to use

- Multiple PRs ready to merge after a morning of dev work
- After a sprint's worth of issues finished CI at roughly the same time
- When you want to cross a pass-rate milestone in one batch

## Step 1: Gather candidate PRs

```bash
gh pr list --limit 20 --json number,title,headRefName,mergeable,mergeStateStatus
```

Filter to PRs with `mergeStateStatus: UNSTABLE | CLEAN | BEHIND` — skip `DIRTY` (conflict, ping dev to refresh) and `DRAFT`.

## Step 2: Download every PR's merged-report artifact

The sharded workflow uploads `test262-merged-report` per run. Find each PR's run ID via the `merge shard reports` check:

```bash
mkdir -p output/pr-artifacts
for pr in <LIST>; do
  run_id=$(gh pr view $pr --json statusCheckRollup --jq '.statusCheckRollup[] | select(.name=="merge shard reports") | .detailsUrl' | grep -oE 'runs/[0-9]+' | head -1 | cut -d/ -f2)
  mkdir -p output/pr-artifacts/pr-$pr
  gh run download $run_id -n test262-merged-report -D output/pr-artifacts/pr-$pr >/dev/null 2>&1
done
```

Artifact filenames: `test262-report-merged.json`, `test262-regressions.txt`, `test262-results-merged.jsonl`.

## Step 3: Compute and rank net deltas

```bash
BASELINE=$(python3 -c "import json; d=json.load(open('benchmarks/results/test262-current.json')); print(d['summary']['pass'])")

for pr in <LIST>; do
  rpt=output/pr-artifacts/pr-$pr/test262-report-merged.json
  [ -f "$rpt" ] && python3 -c "
import json
d=json.load(open('$rpt'))
s=d['summary']
delta=s['pass']-$BASELINE
print(f'PR #$pr  pass={s[\"pass\"]}  delta={delta:+d}  ce={s[\"compile_error\"]}')
"
done | sort -t= -k3 -n -r
```

## Step 4: Classify each PR

Thresholds (tune per context):

| Delta | Action |
|-------|--------|
| **< −500** | CATASTROPHIC → close immediately with diagnosis. Do NOT merge. |
| **−500 to −20** | Real regression → close, open follow-up issue, ask dev to investigate root cause |
| **−20 to +20** | MARGINAL → check if regressions are false positives; if yes merge, if no close |
| **+20 to +100** | GOOD → sample regressions, admin-merge if regressions are false positives or acceptable |
| **+100+** | STRONG → admin-merge, flag regressions in a follow-up issue |

Sample regressions for any PR where the regression count is > 5% of the delta:

```bash
head -40 output/pr-artifacts/pr-<NUM>/test262-regressions.txt
```

Look for known false-positive patterns (see `feedback_regression_analysis.md`): harness wrapper coincidence, `String.prototype` wrapper tests, test expecting SyntaxError where we throw a different error at a matching phase, etc.

## Step 5: Execute the ranked merges

Descending by net delta, skipping catastrophes and conflicts:

```bash
gh pr merge <NUM> --merge --admin --body "Net +<DELTA> pass. <CLASSIFICATION NOTES>."
```

Use `--admin` when `mergeStateStatus: UNSTABLE` (sharded CI flagged regressions but the net is positive).
Use plain `--merge` (no `--admin`) when `mergeStateStatus: CLEAN`.

## Step 6: Close losers

```bash
gh pr close <NUM> --comment "Net <DELTA> pass. <ROOT CAUSE IF KNOWN>. Reopening issue for a narrower retry."
```

## Step 7: Ping DIRTY PRs

For every conflicting PR that had a good delta on its pre-merge-wave CI run, send a `SendMessage` to the assigned dev:

> "PR #NNN is CONFLICTING against new main after today's merges. Please `git merge origin/main` in your worktree, resolve, push. Your pre-merge delta was +NNN — don't let it rot."

## Step 8: Verify and log

```bash
git fetch origin main --quiet
git log --oneline origin/main -<NUM_MERGES+2>
```

Append to `plan/diary.md`:
- PRs merged with deltas
- PRs closed with reasons
- Follow-up issues filed
- Total net delta
- Gap to next milestone

## Output

A short summary to the user:

```
Merged: #43 (+258), #68 (+106), #71 (+56), #64 (+34)
Closed: #72 (catastrophic -18504), #75 (-114), #65 (orphaned +2)
DIRTY: #74 (dev-1016 refreshing)
Net: +454 pass. Baseline 20711 → ~21165. Gap to 50%: ~400.
```

## Notes

- **Baseline drift during merge:** the deltas you computed are vs the *old* baseline. Each merge adds its pass delta but also potentially introduces new regressions that weren't visible in per-PR CI. The final sharded refresh commit is the source of truth.
- **Skip-CI tag on baseline refresh:** baseline commits include `[skip ci]` to avoid retriggering the sharded workflow. PR #70 added an explicit Pages deploy dispatch so the landing page still updates.
- **Allow-regressions override:** if the post-merge sharded run fails on regressions, re-run with `gh workflow run "Test262 Sharded" --ref main -f allow_regressions=true` to force the baseline refresh.
