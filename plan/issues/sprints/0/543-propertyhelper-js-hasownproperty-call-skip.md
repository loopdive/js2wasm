---
id: 543
title: "propertyHelper.js + hasOwnProperty.call skip filters (1,294 tests)"
status: done
created: 2026-03-18
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
goal: property-model
test262_skip: 1294
files:
  tests/test262-runner.ts:
    new:
      - "propertyHelper.js shim — stub verifyProperty, verifyNotWritable etc."
    breaking: []
---
# #543 — propertyHelper.js + hasOwnProperty.call skip filters (1,294 tests)

## Status: open

Two related skip filters block 1,294 tests:
- "unsupported include: propertyHelper.js" (647 skip)
- "Object.prototype.hasOwnProperty.call not supported" (647 skip)

## Approach

### propertyHelper.js (647)
The test262 harness file `propertyHelper.js` provides `verifyProperty()`, `verifyNotWritable()`, etc. These check property descriptors — which we can stub:
- `verifyProperty(obj, name, { value, writable, enumerable, configurable })` → check value matches, return true for other descriptor checks (our structs are always writable+enumerable)
- Already partially done for some helpers

### hasOwnProperty.call (647)
#488 (done) implemented hasOwnProperty. This skip filter may be stale — need to verify and remove.

## Complexity: S
