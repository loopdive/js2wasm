---
id: 1251
title: "baseline-validate: TS checker non-determinism causes 19/50 false failures on main JSONL"
status: in-progress
created: 2026-05-02
updated: 2026-05-02
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: investigation
area: ci
language_feature: test-infrastructure
goal: ci-hardening
related: [1218, 1246]
---

## Root cause + fix (2026-05-02, dev-1245)

Not actually TS-checker non-determinism — it's a **flag mismatch** between
the sharded runner and the validator.

**Discovery**: the sharded test262 runner (`scripts/compiler-fork-worker.mjs`,
which records the committed JSONL via `precompile-tests.ts`) calls
`compile()` with `skipSemanticDiagnostics: true`. The validator's
`runTest262File` (`tests/test262-runner.ts:2457`) does NOT pass this flag.

So when the validator re-checks a sampled "pass" entry, TypeScript runs
full semantic diagnostics on the wrapped test source. Many test262
fixtures contain TS-incompatible patterns ("Argument of type '{}' is
not assignable to parameter of type '[any]'", "Type 'IArguments' is not
assignable to type 'boolean | undefined'", etc.) that the sharded runner
ignores via `skipSemanticDiagnostics: true`. The validator rejects them
as `compile_error` — false-positive corruption signal.

The "non-determinism" symptom was the seed-driven sample landing on
different counts of TS-incompatible-but-recorded-as-pass tests on
different PR runs (PR_NUMBER seeds the PRNG).

**Fix**: pass `skipSemanticDiagnostics: true` to `compile()` in
`runTest262File`. One-line change. Aligns the validator with the
production sharded runner.

**Verification**: 5 seeds × 50 samples each — all 5 runs report 0
failures. Previous repro (seed 4967) went from 6 failures to 0.

```
=== seed 4626 ===  Validated 50 entries in 7.9s. Failures: 0.
=== seed 12345 === Validated 50 entries in 5.3s. Failures: 0.
=== seed 67890 === Validated 50 entries in 3.7s. Failures: 0.
=== seed 11111 === Validated 50 entries in 3.4s. Failures: 0.
=== seed 99999 === Validated 50 entries in 4.3s. Failures: 0.
=== seed 4967 (was 6 failures) === Validated 50 entries in 10.2s. Failures: 0.
```

### Why the original "TS state pollution" hypothesis was wrong

The issue's investigation hypothesised that TS internal cache pollution
(`createProgram()` reuse, lib loading order, vitest worker pool state)
caused the false failures. I initially implemented a retry-pass to
distinguish transient from real failures — but discovered the failures
were 100% deterministic and persistent on retry (transient: 0, real: 6
on seed 4967). That ruled out state pollution and pointed at a
configuration mismatch instead. The retry-pass approach was reverted in
favour of the one-line flag alignment.

### Acceptance criteria

1. ☑ `pnpm run test:262:validate-baseline` runs 3+ times with different seeds without spurious failures (5/5 seeds clean locally)
2. ☐ CI `baseline-validate` passes on a clean main PR (validated by this PR's own CI)
3. ☑ Root cause documented in this issue file

---

# #1251 — baseline-validate: TS checker non-determinism causes false failures in committed JSONL

## Problem

`test262-baseline-validate.yml` consistently fails on PRs with 19/50 sampled entries reporting
failures that are not caused by the PR's code changes. Proof from PR#149 (#1238):

1. Triggered `refresh-committed-baseline.yml` on main → "JSONL unchanged — nothing to commit."
   The committed JSONL is already in sync with the latest sharded run.
2. Reverting all #1238 source changes to origin/main still produces 19/50 failures with
   seed 4626, exact same tests.
3. The 19 failures are TypeScript-checker crashes / type-check rejections:
   - `L93:10 Argument of type '{}' is not assignable to parameter of type '[any]'`
   - `Cannot read properties of undefined (reading 'kind')`

These are not Wasm runtime failures — they're TS compile-time errors that fire non-deterministically
depending on TS checker state at the time of validation.

## Root cause hypothesis

The committed JSONL records some tests as "pass" that only pass in a clean-state TS checker run.
When the validator samples those tests and re-runs them, it sometimes gets a different TS checker
state (different lib loading order, stale internal caches, or prior-test pollution in the vitest
worker pool) and sees a crash instead of the expected "pass".

Candidate causes:
1. **TS lib loading order** — `lib.d.ts` files loaded lazily; different worker initializations
   produce different type environments.
2. **TS internal cache pollution** — TypeScript's `createProgram()` reuses structures across
   repeated calls in the same worker; one test's types bleed into another.
3. **Genuine TS bug on these specific inputs** — some test262 source patterns trigger a TS
   checker defect that only manifests after certain prior state.

## Impact

Every PR that touches `src/**` will see a spurious `baseline-validate` failure unless the JSONL
happens to avoid these 19 tests in its 50-sample draw. This erodes trust in the gate.

## Investigation steps

1. Identify the 19 failing tests — collect their file paths from the seed-4626 run.
2. Run the validator 5 times with different seeds — check if the same tests fail each time
   (systematic) or different tests (random / cache pollution).
3. Try running the validator with `--isolate` (vitest worker isolation) — see if failures disappear.
4. Inspect the 19 failing test files for TS-checker-triggering patterns (complex generics,
   conditional types, etc.).
5. If TS cache pollution: add a `createProgram()` reset between worker compilations in
   `src/compile.ts` or the vitest runner.

## Fix options

- **Isolate TS checker per validation run** — most reliable, adds ~2s per sample.
- **Exclude TS-crash tests from the JSONL baseline** — mark them as `skip` instead of `pass`
  so the validator never expects them to be stable.
- **Increase sample size + retry** — statistically less likely to hit all 19, but not a real fix.

## Acceptance criteria

1. `pnpm run test:262:validate-baseline` runs 3 times with different seeds without spurious failures.
2. CI `baseline-validate` passes on a clean main PR (one with no src/** changes).
3. Root cause documented in `plan/retrospectives/` or a CLAUDE.md note.

## Related

- #1218 — original baseline-validate implementation
- #1246 — differential test262 CI (avoids baseline-validate path for normal PRs)
