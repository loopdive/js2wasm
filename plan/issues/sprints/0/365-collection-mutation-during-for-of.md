---
id: 365
title: "Collection mutation during for-of (15 skip)"
status: done
created: 2026-03-13
updated: 2026-04-14
completed: 2026-03-16
goal: iterator-protocol
---
# Issue #365: Collection mutation during for-of (15 skip)

15 tests were being skipped due to overly broad filters that matched any source
containing both `for...of` and collection mutation methods (`.push`, `.pop`,
`.splice`, `.delete`, `.add`, `.set`, `.clear`) anywhere in the file, even if
the mutation was not inside the for-of loop body.

## Implementation Summary

**What was done:** Removed two duplicate skip filters in `tests/test262-runner.ts`:
1. Lines 197-201: Broad filter matching any for-of + any `.push/.pop/.shift/.unshift/.splice/.delete/.add/.set/.clear`
2. Lines 381-386: Narrower duplicate matching for-of + `array/arr.method` or `.delete/.add/.set`

**What worked:** Simply removing the filters. The tests are now attempted rather
than skipped. Most tests with collection methods alongside for-of loops do not
actually mutate during iteration -- the methods are used to set up test data
before the loop.

**Files changed:**
- `tests/test262-runner.ts` -- removed two collection mutation skip filters

**Tests:** All equivalence tests pass (pre-existing failures unrelated to this change).
