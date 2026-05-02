---
id: 1222
title: "ci: wasm-hash noise filter — exclude byte-identical regressions from PR gate"
status: done
created: 2026-05-01
updated: 2026-05-01
completed: 2026-05-02
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: ci
language_feature: n/a
goal: ci-hardening
es_edition: n/a
related: [1192, 1217]
origin: "S46 regression analysis (2026-05-01): PR #111 had byte-identical Wasm on both branches yet showed net=-3 due to symmetric flip noise. Same 19 fail-flips appeared in unrelated PR #114. The dev-self-merge gate cannot distinguish runner-variance flips from real regressions unless the Wasm hash is tracked."
---
# #1222 — CI: wasm-hash noise filter for PR regression gate

## Problem

The dev-self-merge gate uses `regressions_real` (compile_error + fail transitions,
excluding compile_timeout) to decide if a PR regresses. But runner variance causes
symmetric pass↔fail and pass↔compile_error flips that are unrelated to the branch
content — the compiled Wasm binary is byte-identical on both main and the branch,
but the test outcome differs due to runner scheduling, memory pressure, or GC timing.

Evidence from S46:
- PR #111 (#1198 presize): 37 `regressions_real`, 144 improvements, net=-3.
  8 sampled "regressed" tests produced **identical Wasm binaries** on main vs branch.
  Same 19 pass→fail flips appeared in unrelated PR #114.
- The gate correctly caught this via cross-PR comparison, but required manual analysis
  and a physical-impossibility override argument.

A test with an identical compiled binary cannot regress — the runtime variance is
purely CI noise. The gate should filter these out automatically.

## Solution

### Step 1: Record wasm_sha in test262 JSONL

In `tests/test262-runner.ts` (the vitest-based runner), after a successful compile,
add `wasm_sha` to the result object:

```ts
import { createHash } from 'crypto';
// after: const result = compile(src, opts)
const wasm_sha = result.success
  ? createHash('sha256').update(result.binary).digest('hex').slice(0, 12)
  : null;
// include in JSONL output: { file, status, wasm_sha, ... }
```

For `compile_error` and `compile_timeout` results, `wasm_sha` is `null`. For
`fail` and `pass` results it is the short SHA of the compiled binary.

### Step 2: Update the CI comparison script

In the GitHub Actions workflow that computes `net_per_test` and writes
`.claude/ci-status/pr-N.json` (the test262-merged-report job), filter
the regression list:

```python
regs_real = [
    f for f in base
    if base[f]['status'] == 'pass'
    and new.get(f, {}).get('status', 'pass') != 'pass'
    and new.get(f, {}).get('status') != 'compile_timeout'  # already excluded
    and (
        base[f].get('wasm_sha') is None
        or new.get(f, {}).get('wasm_sha') is None
        or base[f]['wasm_sha'] != new[f]['wasm_sha']   # NEW: Wasm changed
    )
]
```

A test that appears to "regress" but has the same `wasm_sha` on both
main and branch is definitionally a CI noise flip — exclude it from
`regressions_real`.

Add `regressions_wasm_change` to the JSON feed (count of regressions
where the Wasm actually changed) alongside the existing fields.

### Step 3: Backfill baseline JSONL

The committed baseline `benchmarks/results/test262-current.jsonl` needs
`wasm_sha` entries. Run a one-time recompile of all tests (or just the
currently-passing ones) to populate it. This can be done as part of
`refresh-committed-baseline.yml`.

### Step 4: Update dev-self-merge skill

Replace the `regressions_real` field reference with `regressions_wasm_change`
(or whichever field is smallest — keep backward compat via `??` fallback):

```bash
R=$(jq -r '.regressions_wasm_change // .regressions_real // .regressions' \
    .claude/ci-status/pr-N.json)
```

## Acceptance criteria

1. `tests/test262-runner.ts` writes `wasm_sha` (12-char hex) for every
   successful compile in the JSONL output
2. CI comparison script computes `regressions_wasm_change` — regressions
   where the Wasm binary actually changed vs baseline
3. `.claude/ci-status/pr-N.json` includes `regressions_wasm_change` field
4. `dev-self-merge` skill uses `regressions_wasm_change` for criterion 2
5. Symmetric-flip pattern (as in PR #111) no longer triggers gate failure
6. No performance regression in CI runtime (sha256 of each binary is O(binary_size) ≈ negligible)

## Out of scope

- Noise in compile_timeout transitions — already handled by #1192
- Detecting non-deterministic Wasm output (same source, different binary across runs) — that's a compiler correctness bug, not CI noise

## Why not a double-run approach

Running each regressed test twice to check for flakiness costs O(regressions) extra
test runs per PR — potentially hundreds. The wasm-hash approach is O(1) per test
and is provably correct (identical binary = identical semantics in a deterministic
Wasm engine).
