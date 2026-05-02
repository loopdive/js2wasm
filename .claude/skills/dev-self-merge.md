---
name: dev-self-merge
description: Algorithmic gate for self-merging a PR. Reads CI JSON, applies 4 hard criteria in order, outputs MERGE or ESCALATE. No judgment calls.
---

# /dev-self-merge \<N\>

Run this after `.claude/ci-status/pr-<N>.json` exists with a SHA matching your branch HEAD.

## Step 0 — fast-path for non-test262 PRs

If `.claude/ci-status/pr-<N>.json` does not exist, check whether Test262 was
required for this PR:

```bash
gh pr view <N> --json files --jq '[.files[].path | select(startswith("src/"))] | length'
```

If the result is **0** (no `src/**` changes), Test262 Sharded was not required.
Check basic CI instead:

```bash
gh pr view <N> --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.conclusion != null)] |
        { total: length,
          failed: [.[] | select(.conclusion == "FAILURE" or .conclusion == "failure")] | length }'
```

- If `failed == 0` and `total > 0`: output **MERGE** and skip to Step 5.
- If `failed > 0`: output **ESCALATE — basic CI failed. Check which checks failed before merging.**
- If `total == 0` (no checks at all): output **MERGE** — workflow-only, no CI gates apply.

If `src/**` changes exist but no status file: CI is still in-flight. Wait.

## Step 1 — read the feed

```bash
cat .claude/ci-status/pr-<N>.json
```

Extract: `head_sha`, `net_per_test`, `regressions`, `regressions_real`,
`regressions_wasm_change`, `wasm_identical_noise`, `compile_timeouts`,
`improvements`, `run_url`.

`regressions_wasm_change` (added by #1222) = regressions where the
compiled Wasm binary differs between base and PR (excluding
`compile_timeout`). Pass→fail flips on a byte-identical binary are
physically impossible compiler regressions — they're CI runner variance
(scheduling, memory pressure, GC timing). This is the preferred field
for the ratio check in criterion 2.

`regressions_real` (added by #1192) = `compile_error + fail` regressions
only — excludes `compile_timeout` transitions which are runner-load
timing noise (tests right at the 30s compile-timeout boundary flap
based on CI system load). Used as a fallback when `regressions_wasm_change`
is null (older CI feed).

**`compile_timeout` transitions are NOT counted — runner timing noise.**
**Wasm-identical pass→fail flips are NOT counted — runner variance noise.**

Field priority (use the first non-null):
`regressions_wasm_change` → `regressions_real` → `regressions`

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
| 2 | `R == 0 OR R / improvements < 0.10`, where `R = regressions_wasm_change ?? regressions_real ?? regressions` | **ESCALATE — regression ratio is N% (R/improvements), exceeds 10% threshold.** |
| 3 | No bucket > 50 regressions (see Step 4) | **ESCALATE — bucket "\<path\>" has N regressions, exceeds 50-test limit.** |
| 4 | All above pass | **MERGE** |

`R` (criterion 2) prefers `regressions_wasm_change` if the feed has it
(post-#1222 CI). This filters out byte-identical-binary pass→fail flips,
which are CI runner variance, not real regressions. Falls back to
`regressions_real` (post-#1192, excludes compile_timeout), then to the
headline `regressions` count. Excluding wasm-identical noise and
`compile_timeout` prevents CI variance from tipping otherwise-clean PRs
above the 10% threshold. Compute it in shell with:

```bash
R=$(jq -r '.regressions_wasm_change // .regressions_real // .regressions' .claude/ci-status/pr-<N>.json)
```

If `regressions` is `null` in the feed (older CI format without per-test tracking): treat criterion 2 as **pass** and skip criterion 3 (no data to bucket). Proceed to MERGE if criterion 1 holds.

## Step 4 — bucket regressions (only if regressions > 0)

Download the merged report artifact:

```bash
run_id=$(jq -r '.run_url' .claude/ci-status/pr-<N>.json | grep -oE 'runs/[0-9]+' | cut -d/ -f2)
mkdir -p output/sm-<N>
gh run download "$run_id" -n test262-merged-report -D output/sm-<N>
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
- **`regressions_wasm_change`** (#1222) — regressions where the Wasm binary changed (excluding `compile_timeout`). Preferred for criterion 2.
- **`wasm_identical_noise`** (#1222) — pass→other transitions where the Wasm binary is byte-identical on base & PR. These are CI runner variance, **not** real regressions, and are excluded from `regressions_wasm_change`.
- **`regressions_real`** (#1192) — `compile_error + fail` regressions, excludes `compile_timeout`. Fallback for criterion 2.
- **`snapshot_delta`** = bulk pass-count difference vs committed baseline. NOT a merge criterion — contaminated by baseline drift. Ignore it.
