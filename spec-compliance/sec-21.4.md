# §21.4 Date Objects

**Spec**: https://tc39.es/ecma262/#sec-date-objects
**Status**: ⚠️ partial
**Test262 categories**: `built-ins/Date`
**Coverage**: 360 / 594 pass (60.6%) — 234 fail, 0 skip
**Top error buckets**: assertion_fail=199, other=14, type_error=8

## What the spec requires

Date is a host externref wrapper; all Date.prototype methods forward to the host. Date.now uses Date.now host import.

## Current implementation

Files / runtime imports involved:

- `src/runtime.ts (host imports)`

## Gap

360/594 (60.6%). 199 assertion_fail — likely Date string parsing (Date.parse format quirks), year-2-digit handling, and timezone-offset edge cases.

## Issues filed / referenced

- [#1344](../plan/issues/sprints/50/1344-*.md)
