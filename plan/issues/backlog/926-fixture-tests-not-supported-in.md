---
id: 926
title: "Fixture tests not supported in unified mode (172 CE)"
status: ready
created: 2026-04-03
updated: 2026-04-28
priority: low
feasibility: medium
reasoning_effort: high
goal: test-infrastructure
test262_ce: 172
---
# #926 -- Fixture tests not supported in unified mode (172 CE)

## Problem

172 test262 tests fail with `fixture tests not supported in unified mode` or `[compile_error] fixture tests not supported in unified mode`. These are module-code tests that require multi-file fixtures (importing from other test files). Our unified-mode test runner does not support multi-file compilation.

## Error pattern

```
fixture tests not supported in unified mode
[compile_error] fixture tests not supported in unified mode
```

## Sample test files

- `test/language/module-code/eval-gtbndng-indirect-trlng-comma.js`
- `test/language/module-code/export-expname-from-unpaired-surrogate.js`
- Most are in `test/language/module-code/` directory

## Root cause

The test262 runner compiles each test as a single file. Fixture tests require loading multiple files and linking them together. The runner detects fixture tests and emits this error instead of attempting compilation.

## Acceptance criteria

- [ ] Fixture tests are either (a) properly supported with multi-file compilation, or (b) moved to skip filter with a documented reason
- [ ] If skipped: skip filter entry references this issue
- [ ] If supported: >=150 of 172 tests move from CE to PASS or FAIL (not CE)

## Notes

This may not be worth implementing if the fixture tests cover ES module semantics we don't support yet. Consider skip-filtering these as "module-fixture" and revisiting when ES module support improves.

## 2026-04-06 Re-analysis

Latest fully inspectable full JSONL (`20260403-024807`) still shows **172**
fixture-related compile errors, but they appear under two string forms:

- `fixture tests not supported in unified mode` — 86 tests
- `[compile_error] fixture tests not supported in unified mode` — 86 tests

These are not separate root causes. They are the same module-fixture limitation
surfacing through two reporting paths in the unified runner.

Current samples remain concentrated in `language/module-code/`, including:

- `test/language/module-code/eval-gtbndng-indirect-trlng-comma.js`
- `test/language/module-code/export-expname-from-unpaired-surrogate.js`
- `test/language/module-code/import-attributes/import-attribute-trlng-comma.js`

## 2026-04-07 Recheck update

Fresh full recheck (`benchmarks/results/test262-results-20260407-005506.jsonl`)
shows this bucket is unchanged at **172 compile errors**:

- `fixture tests not supported in unified mode` — 86 tests
- `[compile_error] fixture tests not supported in unified mode` — 86 tests

This confirms that the improved compiler error-location work (#985) did not
change the underlying fixture limitation. It remains a pure unified-runner
capability gap, not a codegen regression.
