---
id: 437
title: "Cannot find module empty_FIXTURE.js -- test infrastructure gap (38 CE)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-03-18
priority: low
goal: contributor-readiness
test262_ce: 38
complexity: XS
files:
  tests/test262-runner.ts:
    breaking:
      - "module resolution -- handle empty_FIXTURE.js import references"
---
# #437 -- Cannot find module empty_FIXTURE.js: test infrastructure gap (38 CE)

## Problem

38 tests fail with "Cannot find module './empty_FIXTURE.js'" or similar FIXTURE module resolution errors. These are test262 infrastructure files that the test runner does not resolve.

This is a test harness issue, not a compiler bug. The test262 suite includes FIXTURE files as helper modules for certain tests. The runner needs to either:
1. Skip tests that depend on FIXTURE files
2. Provide stub modules for common FIXTURE patterns

## Priority: low (38 tests, not a compiler issue)

## Complexity: XS

## Acceptance criteria
- [x] Tests depending on FIXTURE files are either properly handled or skipped
- [x] No false CE counts from missing FIXTURE modules

## Implementation Summary

Two changes to `tests/test262-runner.ts`:

1. **Added `import-defer` to `UNSUPPORTED_FEATURES`**: Most of the 40 FIXTURE failures were in `language/expressions/dynamic-import` tests using the `import-defer` feature, which is a Stage 3 TC39 proposal we don't support. Adding it to the unsupported set catches ~39 of the 40 tests via their feature metadata.

2. **Added `_FIXTURE.js` source-level skip in `shouldSkip`**: A regex check (`/_FIXTURE\.js/`) on the test source catches any test that imports a FIXTURE helper module (e.g., `import './empty_FIXTURE.js'`, `import './sync_FIXTURE.js'`). This handles the remaining edge case (the `import.meta/distinct-for-each-module.js` test which uses a static import of a FIXTURE file).

Note: The existing `findTestFiles` function already excluded files with `_FIXTURE` in their name (line 1785), but tests that *import* FIXTURE files were not filtered. The new source-level check closes this gap.

### Files changed
- `tests/test262-runner.ts` -- added `import-defer` to UNSUPPORTED_FEATURES, added `_FIXTURE.js` source check in `shouldSkip`

### Tests affected
- ~40 test262 tests now correctly skipped instead of producing false compile_error CE counts
