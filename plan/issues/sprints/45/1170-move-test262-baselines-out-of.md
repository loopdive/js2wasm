---
id: 1170
title: "Move test262 baselines out of Git LFS — eliminate LFS dependency from CI"
status: done
created: 2026-04-24
updated: 2026-04-24
completed: 2026-04-25
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci
goal: ci-hardening
parent: 1080
---
# #1170 — Move test262 baselines out of Git LFS

## Problem

GitHub LFS has a 1 GB storage + 1 GB bandwidth/month free quota that applies
equally to public and private repos. The project's accumulated test262 baseline
`.jsonl` files (each ~17 MB) pushed across 44+ sprints have exhausted the LFS
budget. Symptoms:

- `promote-baseline` CI job fails at `git lfs pull` with "exceeded its LFS budget"
- Committed baseline freezes at the last successfully promoted result (24,483 pass,
  56.7%, from before sprint 44)
- GitHub Pages pass-rate display stays stale indefinitely

The `continue-on-error` fix in #1078 (merged) prevents CI from blocking, but
the trend graph (`runs/index.json`) cannot be updated while LFS is down.

## Root cause

`.gitattributes` tracks `*.jsonl` via LFS. Every baseline promotion commits a
new 17 MB LFS object. After 44+ sprints of refreshes the cumulative LFS storage
(not bandwidth) exceeds 1 GB. Making the repo public does **not** help — LFS
quotas are the same regardless of visibility.

## Fix

### Part 1: Move baseline artifacts to a separate repository

Create `loopdive/js2wasm-baselines` as a thin public repo for data only:

```
js2wasm-baselines/
  test262-current.jsonl       (latest baseline, ~17 MB)
  test262-current.json        (latest summary JSON)
  test262-results.jsonl       (latest full run)
  runs/index.json             (trend history, ~26 KB)
  public/                     (copies for Pages, if needed)
```

- No LFS — these are regular git files in a dedicated repo. Each push replaces
  the file in place; git history for this repo is shallow (--depth=1 on clone).
- CI accesses it via `git clone --depth=1
  https://x-access-token:${{ secrets.BASELINE_REPO_TOKEN }}@github.com/loopdive/js2wasm-baselines.git`

### Part 2: Update `.github/workflows/test262-sharded.yml`

In `promote-baseline`:
1. Clone the baselines repo (shallow)
2. Copy artifacts into it
3. `git push` (force-push or regular push, always replaces)

In `regression-gate` (for PRs):
1. Clone the baselines repo (shallow) to get the latest committed baseline
2. Use that for comparison (replaces the `git show origin/main:...` fetch)

Remove the `git lfs pull` step entirely (since there is no more LFS dependency).

### Part 3: Remove baseline files from LFS tracking in main repo

In `/workspace/.gitattributes`, remove or scope down:
```
# BEFORE:
*.jsonl filter=lfs diff=lfs merge=lfs -text

# AFTER (keep non-baseline jsonl out of LFS, or remove entirely):
# *.jsonl filter=lfs diff=lfs merge=lfs -text  ← REMOVE
```

Add the baseline files to `.gitignore` in the main repo (they no longer live here).

### Part 4: Purge old LFS objects (optional, frees the budget)

After Part 3 lands and the baseline repo is operational:
```bash
git lfs migrate export --include="*.jsonl" --everything
git push --force  # rewrite history to remove LFS objects
```

Or just let the old LFS objects age out — once they're no longer referenced by
any branch/tag, GitHub will GC them eventually.

## Credentials

The CI workflow needs a `BASELINE_REPO_TOKEN` secret (a GitHub PAT with `repo`
scope on `loopdive/js2wasm-baselines`). Add it in the repo settings. Or use a
deploy key with write access.

Alternatively, use GitHub Actions `GITHUB_TOKEN` cross-repo by granting the
js2wasm Actions bot write access to js2wasm-baselines.

## Acceptance criteria

- [ ] `loopdive/js2wasm-baselines` repo created and readable
- [ ] `promote-baseline` job pushes to baselines repo instead of committing to main
- [ ] `regression-gate` fetches baseline from baselines repo on PRs
- [ ] `.gitattributes` no longer tracks `*.jsonl` via LFS in main repo
- [ ] `benchmarks/results/test262-current.jsonl` removed from main repo (gitignored)
- [ ] GitHub Pages pass rate updates after next CI run
- [ ] `runs/index.json` trend graph resumes appending

## Notes

- The `runs/index.json` is 26 KB and was also LFS-tracked. Move it to the
  baselines repo alongside the other files.
- `public/benchmarks/results/*.json` (also LFS-tracked) — move to baselines repo
  or regenerate on the fly in Pages build.
- This unblocks #1079 (baseline age badge) fully — the age stamp can now be
  read from the baselines repo where it was committed.
- Precedent: many large open-source projects use a separate data/assets repo
  for generated artifacts. Standard pattern.
