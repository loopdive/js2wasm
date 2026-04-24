---
name: dev-self-merge
description: Algorithmic gate for self-merging a PR. Reads CI JSON, applies 4 hard criteria in order, outputs MERGE or ESCALATE. No judgment calls.
---

# /dev-self-merge \<N\>

Run this after `.claude/ci-status/pr-<N>.json` exists with a SHA matching your branch HEAD.

## Step 1 — read the feed

```bash
cat .claude/ci-status/pr-<N>.json
```

Extract: `head_sha`, `net_per_test`, `regressions`, `improvements`, `run_url`.

## Step 2 — SHA check

```bash
git rev-parse HEAD
```

If `head_sha` in the JSON ≠ `git rev-parse HEAD` output:

> **ESCALATE — SHA mismatch. CI ran on a different commit. Push again and wait for a new CI result.**

Stop.

## Step 3 — criteria (in order, stop at first failure)

| # | Criterion | Failure output |
|---|-----------|----------------|
| 1 | `net_per_test > 0` | **ESCALATE — net_per_test is not positive (value: N). PR caused more regressions than improvements.** |
| 2 | `regressions == 0 OR regressions / improvements < 0.10` | **ESCALATE — regression ratio is N% (regressions/improvements), exceeds 10% threshold.** |
| 3 | No bucket > 50 regressions (see Step 4) | **ESCALATE — bucket "\<path\>" has N regressions, exceeds 50-test limit.** |
| 4 | All above pass | **MERGE** |

If `regressions` is `null` in the feed (older CI format without per-test tracking): treat criterion 2 as **pass** and skip criterion 3 (no data to bucket). Proceed to MERGE if criterion 1 holds.

## Step 4 — bucket regressions (only if regressions > 0)

Download the merged report artifact:

```bash
run_id=$(jq -r '.run_url' .claude/ci-status/pr-<N>.json | grep -oE 'runs/[0-9]+' | cut -d/ -f2)
mkdir -p /tmp/sm-<N>
gh run download "$run_id" -n test262-merged-report -D /tmp/sm-<N>
```

Bucket by path prefix:

```bash
python3 - <<'EOF'
import json
from collections import Counter

base = {}
with open('benchmarks/results/test262-current.jsonl') as f:
    for line in f:
        try: d = json.loads(line); base[d['file']] = d['status']
        except: pass

new = {}
with open('/tmp/sm-<N>/test262-results-merged.jsonl') as f:
    for line in f:
        try: d = json.loads(line); new[d['file']] = d['status']
        except: pass

regs = [f for f in base if base[f] == 'pass' and new.get(f, 'pass') != 'pass']
buckets = Counter('/'.join(f.split('/')[:5]) for f in regs)
print(f"Total regressions: {len(regs)}")
for path, count in buckets.most_common(10):
    flag = " <- EXCEEDS 50" if count > 50 else ""
    print(f"  {count:4d}  {path}{flag}")
EOF
```

Any bucket with count > 50 → **ESCALATE** with the bucket name and count (criterion 3 above).

## Step 5 — merge

All criteria passed. Run:

```bash
gh pr merge <N> --merge --admin \
  --body "Self-merged. net_per_test=+$(jq .net_per_test .claude/ci-status/pr-<N>.json) ($(jq .improvements .claude/ci-status/pr-<N>.json) improvements, $(jq .regressions .claude/ci-status/pr-<N>.json) regressions). Criteria: /dev-self-merge."
```

Then:
1. `TaskUpdate taskId=<your-task> status=completed`
2. `TaskList` → claim next unowned task

## What ESCALATE means

Post to tech lead via SendMessage with:
- Which criterion failed
- The exact values from the CI JSON
- The PR number

Do not merge. Do not move to the next task. Own the issue until it resolves.

## What these fields mean

- **`net_per_test`** = `improvements - regressions` — per-test transitions from `diff-test262.ts`. The merge gate.
- **`snapshot_delta`** = bulk pass-count difference vs committed baseline. NOT a merge criterion — contaminated by baseline drift. Ignore it.
