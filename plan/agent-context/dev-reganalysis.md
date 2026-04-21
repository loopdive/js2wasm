---
agent: dev-reganalysis
role: senior-developer
last_active: 2026-04-21
status: shutdown
---

# dev-reganalysis — context summary

## Assigned task

Investigate April 19 test262 regression cascade (sprint-42/begin 22,412 pass → current ~21,324 pass, −1,088 net). Identify distinct root causes, file one issue per cluster in `plan/issues/backlog/`, update `plan/issues/backlog/backlog.md`, report to team-lead. Rules: no full test262 runs, no commits, scratch files in `.tmp/`.

## What I did

1. Read prior investigation at `plan/agent-context/senior-dev-audit.md` (2026-04-20) — ~95% of regressions already identified as inherited/false-positive from April 19 merges that violated self-merge protocol (#153, #174, #177 all merged 17:51:35–40).
2. Inspected PR #195 (`src/codegen/property-access.ts`, commit bd3ab86b) — narrow `__extern_get(__extern_get(globalThis, "<Ctor>"), "prototype")` intercept for `String`/`Number`/`Boolean.prototype`.
3. Inspected PR #177 (`src/codegen/declarations.ts`, commit 3199346d) — `_start` export only when no other exported function. Confirmed test262 tests always export `function test()` (see `tests/test262-runner.ts:1872`) so the preserved guarded path runs — PR #177 does NOT directly affect test262 tests.
4. Tallied error clusters in `benchmarks/results/test262-results.jsonl`.
5. Local repro of Array.prototype higher-order issue via `.tmp/probe-array-every3.mts` — `Array.prototype.every.call(obj, fn)` → `object is not a function`.
6. Filed 4 new issue files in `plan/issues/backlog/`:
   - **#1153** — RegExp constructor called with `flags="undefinedy"` on String.prototype method paths (288 tests, high priority)
   - **#1154** — Array.prototype poisoning leaks into TS compiler `Array.from` call at compile time (378 tests, high, `depends_on: [1119]`)
   - **#1155** — test262 worker classifies WebAssembly.Exception as compile_error with `[object WebAssembly.Exception]` string (1,415 tests, medium, easy fix)
   - **#1156** — `Array.prototype.X.call(arrayLike, numericInit)` → "number N is not a function" (164 tests, medium, `depends_on: [1152]`)
7. Edited `plan/issues/backlog/backlog.md` — added "Harvest 2026-04-21 — April 19 regression cascade" section listing all 4 issues.

## Key findings (not obvious from code)

- **Many reported compile_errors are cache hits**: `compile_ms: 1–2` on failing entries = stored error from a prior poisoned run, not a fresh compile failure. Sample "failing" tests compiled cleanly when invoked via the `compile()` API directly.
- **PR #195 prototype-routing side effect**: narrow intercept is correct for `String.prototype` etc., but a downstream path constructs `RegExp(pattern, self.flags + "y")` where `self.flags` resolves to `undefined` — yielding the `"undefinedy"` pattern seen in the 288-test cluster (#1153).
- **Incremental compiler state leak is the big hitter**: `scripts/test262-worker.mjs` reuses an `incrementalCompiler` across RECREATE_INTERVAL=100 tests. Array.prototype mutations from one test leak into the compiler's own `Array.from(...)` call on the next (#1154). Existing #1119 covers checker-state leak; #1154 is the sibling covering prototype-descriptor leak.
- **PR #177 is NOT the culprit** for the 837 tests in its "fingerprint" — the `_start` export path only fires for modules with no user exports; test262 wrapper always exports `test`, so the old guarded path runs unchanged.

## Recommended fix order (highest leverage first)

1. **#1155** — easy fix in `scripts/test262-worker.mjs` L383–395, classification bug. Recovers **1,415 tests** immediately.
2. **#1119 + PR #232** — already in progress; recovers ~3,527 tests.
3. **#1152 + #1156** — same codepath (Array.prototype method-as-value via `.call()`). Recovers ~456 tests.
4. **#1154** — worker prototype snapshot/restore; recovers 378.
5. **#1153** — RegExp flags assembly fix; recovers 288.

Total if landed in order: **~6,064 tests recovered**, back toward 22,400+ pass.

## Collision note (resolved)

Briefly flagged a potential ID collision with senior-dev's `plan/issues/sprints/43/1153.md` (compiler-internal TypeErrors). Team-lead confirmed no collision — `backlog/1153.md` doesn't exist on main and the two files are separate issues. Nothing to reconcile.

## State at shutdown

- No commits made (main was mid-rebase throughout the session).
- No branches created.
- Working tree unchanged except for the 4 new issue files + backlog edit + this context file.
- No running tests or background processes.
- Issues are on disk but untracked — team-lead to stage/commit when main stabilizes.

## How to resume

Not expected to resume — task is complete and self-contained. If a follow-up investigation is needed, start by re-reading the 4 issue files for their root-cause analysis, then move to implementation per the recommended order above.
