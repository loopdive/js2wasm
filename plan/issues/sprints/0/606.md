---
id: 606
title: "Test harness gaps: propertyHelper.js, assert.throws, String() indexer (1,105 tests)"
status: done
created: 2026-03-19
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: error-model
depends_on: [1113]
test262_skip: 1105
files:
  tests/test262-runner.ts:
    new:
      - "propertyHelper.js shim with real descriptor support"
      - "assert.throws harness support"
      - "String() indexer fix in assert"
    breaking: []
---
# #606 — Test harness gaps: propertyHelper.js, assert.throws, String() indexer (1,105 tests)

## Status: open

Three test harness issues block 1,105 tests:

| Filter | Tests | Issue |
|--------|------:|-------|
| unsupported include: propertyHelper.js | 647 | #1114 — needs verifyProperty stubs |
| assert.throws with side-effect assertions | 342 | Runner doesn't support assert.throws with post-throw checks |
| String() indexer in assert | 116 | String used as indexer in assert harness code |

## Approach

1. **propertyHelper.js**: Implement `verifyProperty(obj, name, desc)` — check value matches, read descriptor bitfield from #1113 for writable/enumerable/configurable
2. **assert.throws**: The runner's assert.throws shim needs to capture the thrown value and allow the test to inspect it
3. **String() indexer**: The assert harness uses `String(value)` as an object indexer — needs String() constructor coercion

## Complexity: M
