---
id: 620
title: "ENOENT: double test/ path in test262 runner (559 CE)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: easy
goal: test-infrastructure
test262_ce: 559
files:
  scripts/run-test262.ts:
    breaking:
      - "test file path has double test/ prefix"
---
# #620 — ENOENT: double test/ path in test262 runner (559 CE)

## Status: open

559 tests fail with ENOENT because the file path contains `/test262/test/test/` (double `test/` prefix). The runner constructs the path incorrectly when the test file is already relative to the test directory.

### Example
```
ENOENT: no such file or directory, open '/tmp/ts2wasm-test262-xxx/test262/test/test/language/expressions/class/...'
```

### Fix
In `scripts/run-test262.ts` or `tests/test262-runner.ts`, find where test file paths are constructed and fix the double `test/` join.

## Complexity: S
