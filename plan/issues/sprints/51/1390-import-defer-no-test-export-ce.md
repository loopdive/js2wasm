---
id: 1390
sprint: 51
title: "fix: import-defer proposal tests fail as CE (no test export) when TEST262_INCLUDE_PROPOSALS=1"
status: done
created: 2026-05-08
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: test262-runner
language_feature: import-defer
goal: spec-completeness
---
# #1390 — import-defer tests show as CE "no test export" in CI

## Problem

31 tests in `language/import/import-defer/` fail with `CE: no test export` when CI runs with
`TEST262_INCLUDE_PROPOSALS=1`. Example tests:

```
language/import/import-defer/syntax/invalid-default-and-defer-namespace.js
language/import/import-defer/syntax/invalid-defer-default.js
language/import/import-defer/syntax/invalid-defer-named.js
language/import/import-defer/errors/syntax-error/import-defer-of-syntax-error-fails.js
```

## Root cause

These tests have `features: [import-defer]` in frontmatter, which flags them as proposal-scoped.
When `TEST262_INCLUDE_PROPOSALS=1` (default for push/PR in CI), they are included in the run.

The files are **syntax-only tests** with no `export function test()` — they test that the `import defer`
syntax is parsed correctly or that invalid syntax is rejected. TypeScript (which js2wasm uses as its
parser) can parse `import defer * as ns from '...'` — it either ignores or handles the `defer` keyword
— producing a valid Wasm module with no exports. The test runner then sees no `test` export and records
a `compile_error: no test export`.

## Fix options

**Option A (recommended):** Add `import-defer` path to a separate "compile-only skip" list
in the test runner. Tests under `language/import/import-defer/` that have no exports and no
harness runner setup should be excluded from compile+run, or recorded as `skip` rather than CE.

**Option B:** In `tests/test262-runner.ts`, detect tests with `features: [import-defer]` AND
`negative: { phase: parse }` metadata — mark these as `skip` with reason
`"import-defer negative syntax test — not yet supported"` even when proposals are included.

**Option C:** Fully implement `import defer` support (out of scope — large proposal feature).

## Acceptance criteria

1. None of the `language/import/import-defer/` tests appear as `compile_error` in CI.
2. They appear as either `skip` or `fail` (failing to detect the syntax error is a `fail`, not CE).
3. No regression in other import tests.

## Files

- `tests/test262-runner.ts` — add skip or reclassification logic for import-defer tests

## Estimated yield

~31 CE → skip or fail (net neutral for pass count, but cleaner conformance picture).
