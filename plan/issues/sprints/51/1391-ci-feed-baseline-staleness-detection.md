---
id: 1391
sprint: 51
title: "infra: CI feed baseline staleness detection — warn when baseline_sha diverges from current main"
status: done
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infra
area: ci
goal: reliability
---
# #1391 — CI feed baseline staleness detection

## Background

PR #294 (#1388) had a CI feed showing `net_per_test = -140`, `regressions_real = 495` — which
blocked a merge that was actually net **+103**. The root cause: the CI regression report's
`baseline_sha` (58e1fee70) pointed to a stale main commit, not the tip of main at the time
the PR ran. The feed was comparing the branch against an old snapshot where many tests had
already been passing that had since regressed on main — causing hundreds of false regressions.

The bug was caught by the dev doing artifact-to-artifact comparison (branch-merged vs
main-merged from the same CI run). The CI feed `.claude/ci-status/pr-NNN.json` is not
authoritative when the baseline is stale.

## Failure mode

```
CI feed baseline_sha = 58e1fee70   ← old main (e.g. 500 commits ago)
Current main tip SHA = 1068e5424   ← has 270 more passes than baseline

Result:
  tests that pass on current main but were "fail" at baseline_sha
  → show up as IMPROVEMENTS in the branch (correctly)

  tests that were "pass" at baseline_sha but now "fail" on current main
  → show up as REGRESSIONS in the branch (INCORRECTLY — they regressed on main, not in the PR)
```

When main has drifted significantly from the baseline snapshot, the regression count is
inflated by all the churn between baseline_sha and main tip.

## Detection approach

In the CI workflow (`test262-sharded.yml`) and/or the CI status feed script, add a staleness
guard:

1. **Compute baseline age**: difference in commit count between `baseline_sha` and `GITHUB_SHA`
   of the current main at PR merge time.
2. **Warn threshold**: if `baseline_sha` is more than N commits behind main (e.g. N=50),
   emit a warning in the CI summary and set a flag in `pr-NNN.json`:
   ```json
   "baseline_staleness_commits": 312,
   "baseline_stale": true
   ```
3. **Hard block**: if `baseline_stale: true`, the `dev-self-merge` gate should escalate
   automatically to tech lead rather than blocking the merge on the raw regression count.
4. **Fallback metric**: when stale, report regression count from **same-run artifact comparison**
   (branch-merged vs main-merged JSONL diff) rather than branch vs committed baseline.

## Acceptance criteria

1. `pr-NNN.json` includes `baseline_staleness_commits` field for every PR.
2. When `baseline_staleness_commits > 50`, `baseline_stale: true` is set in the feed.
3. The `check-cwd.sh` / merge gate respects `baseline_stale: true` and escalates instead
   of hard-blocking.
4. CI summary (GitHub Actions job summary) prints a staleness warning when the flag is set.
5. The committed baseline (`benchmarks/results/test262-current.jsonl`) is refreshed by
   `refresh-committed-baseline.yml` after every main push — ensuring staleness stays low
   under normal operation.

## Related

- `refresh-committed-baseline.yml` — the scheduled workflow that keeps the baseline fresh
- `test262-sharded.yml` — where the regression report is generated
- `check-cwd.sh` — the merge gate that reads `pr-NNN.json`
- PR #294 incident: baseline_sha=58e1fee70, actual net=-140 (feed) vs +103 (artifacts)

## Implementation (PR #TBD)

### Note on the actual feed source

The issue file calls out `test262-sharded.yml` and `check-cwd.sh`, but the
authoritative feed writer is now `.github/workflows/ci-status-feed.yml`,
triggered on `Test262 Differential` completion (see commit bf62a8998 — wired
on May 3 2026 specifically to address staleness). The merge gate logic that
reads the feed lives in `.claude/skills/dev-self-merge.md`, not `check-cwd.sh`
(which is a per-Bash-call cwd guard, unrelated to merge decisions).

This PR therefore touches:

- `.github/workflows/ci-status-feed.yml` — compute and emit
  `baseline_sha`, `baseline_staleness_commits`, `baseline_stale`.
- `.claude/skills/dev-self-merge.md` — short-circuit step 1a that
  escalates to tech lead when `baseline_stale: true`.

### Workflow changes

After parsing `test262-report-merged.json` (which includes the artifact's
`baseline_sha`), the feed writer:

1. Reads `baseline_sha` from the merged-report JSON. If absent / unknown,
   skip the staleness check.
2. `git fetch --depth=200 origin <baseline_sha>` so the merge-base count is
   computable from a shallow checkout.
3. `git rev-list --count baseline_sha..HEAD` → `baseline_staleness_commits`.
4. If `baseline_staleness_commits > 50`, set `baseline_stale: true` and emit
   `::warning::` annotation + a job-summary entry with the drift count.
5. Always include `baseline_sha`, `baseline_staleness_commits`, and
   `baseline_stale` in the JSON output so downstream tooling has them.

### Gate change

`/dev-self-merge` step 1a (new): if `baseline_stale: true`, emit the
escalation prompt and stop — do not run the regression-count criteria, which
would otherwise hard-block on inflated drift numbers.

### Scope notes

- Only `Test262 Differential` triggers `ci-status-feed.yml`. PRs gated by
  `Test262 Sharded` go through a different artifact path; staleness
  detection there can be added later if the team re-introduces the Sharded
  feed writer. (As of bf62a8998 the Sharded path no longer writes the
  PR-level feed.)
- `ci-status-basic.yml` (test/docs-only PRs) writes `test262_skipped: true`
  — no baseline involved, no change needed.

## Acceptance criteria status

- ✅ #1: `pr-NNN.json` includes `baseline_staleness_commits` for every PR
  whose feed comes from `ci-status-feed.yml` and where the artifact carries
  a `baseline_sha`.
- ✅ #2: When `baseline_staleness_commits > 50`, `baseline_stale: true` is
  set in the feed.
- ✅ #3: `/dev-self-merge` (the merge gate that reads `pr-NNN.json`)
  honours `baseline_stale: true` and escalates instead of hard-blocking.
- ✅ #4: CI summary prints a staleness warning + `::warning::` annotation
  when the flag is set.
- (out of scope) #5: `refresh-committed-baseline.yml` already exists and is
  unchanged by this PR — listed in the issue's acceptance criteria as a
  reminder that staleness shouldn't accumulate under normal operation.
