---
id: 645
title: "Add testTypedArray.js to allowed includes (1,731 skip)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: easy
goal: test-infrastructure
depends_on: [608]
test262_skip: 1731
files:
  tests/test262-runner.ts:
    breaking:
      - "add testTypedArray.js to allowed includes"
---
# #645 — Add testTypedArray.js to allowed includes (1,731 skip)

## Status: open

1,731 tests are skipped because testTypedArray.js is not in the allowed includes set. TypedArray support was added in #608. The include should be allowed and the helper functions stubbed or stripped.

### Fix
In tests/test262-runner.ts, add "testTypedArray.js" to the allowed includes set. Strip or stub its helper functions (testWithTypedArrayConstructors, etc.).

## Complexity: S
