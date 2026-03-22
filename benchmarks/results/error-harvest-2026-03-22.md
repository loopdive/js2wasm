# Test262 Error Harvest -- 2026-03-22

## Test Suite Summary

| Metric | Current | Baseline | Delta |
|--------|---------|----------|-------|
| Total tests | 48,102 | 48,102 | -- |
| Pass | 14,720 | 15,232 | -512 (regression) |
| Fail | 27,938 | 26,874 | +1,064 |
| Compile Error (CE) | 4,443 | 5,496 | -1,053 (improvement) |
| Skip | 1,001 | 500 | +501 |

Pass rate: 30.6% (was 31.7%)
CE rate: 9.2% (was 11.4%)

---

## Regressions (2,279 tests went from pass to fail)

### 1. TypeError null access regression -- 1,948 tests

**Root cause**: Interaction between #695 (TypeError throws) and #706 (ref.cast guards).

When #706 guards a `ref.cast` that fails on a valid object of a different struct type, it returns `ref.null`. The #695 null guard then throws TypeError or returns a default -- both wrong for a valid non-null object.

| Category | Regressed |
|----------|-----------|
| TypedArray | 557 |
| Temporal | 307 |
| TypedArrayConstructors | 265 |
| Object | 148 |
| Other | 671 |

**Issue created**: #726 (critical)
**Fix**: Route failed ref.cast to `__extern_get` fallback instead of returning ref.null.

### 2. Negative test false-pass -- 133 tests

Tests that should fail parse but now compile. Likely due to comment stripping removal.

**Existing issue**: Covered by #402 (negative test SyntaxError).

### 3. CE regressions -- 54 tests

Tests that now hit compile errors that did not before. Minor; likely edge effects of other changes.

### 4. Other fail regressions -- 144 tests

Miscellaneous regressions. Needs further triage if #726 fix does not recover them.

---

## Top Error Patterns (non-regression)

### Runtime failures (27,938 total)

| # | Pattern | Count | Issue |
|---|---------|-------|-------|
| 1 | TypeError null/undefined access | 11,969 | #726 (regression portion), #728 (legitimate) |
| 2 | Assertion failed (wrong value) | 11,480 | #727 (needs sub-classification) |
| 3 | Negative test false-pass | 2,657 | #402 |
| 4 | Null pointer dereference (trap) | 1,604 | #728 (new) |
| 5 | Illegal cast (residual) | 134 | #706/#512 |

### Compile errors (4,443 total)

| # | Pattern | Count | Issue | Trend |
|---|---------|-------|-------|-------|
| 1 | Call type mismatch | 1,250 | #698 | +206 from baseline (more tests attempted) |
| 2 | Compiler error with line | 1,022 | Various | -- |
| 3 | Struct type mismatch | 944 | #697 | +131 from baseline |
| 4 | Stack underflow | 362 | #705 | +1 (stable) |
| 5 | Local type mismatch | 270 | #444 | -- |
| 6 | Immutable global | 240 | #704 | -44 (improved) |
| 7 | Stack fallthrough | 103 | #719 | -207 (improved significantly) |

---

## Issues Created

| # | Title | Priority | Type |
|---|-------|----------|------|
| 726 | TypeError regression: ref.cast guard returns ref.null for valid objects | Critical | Bug fix |
| 727 | Sub-classify assertion failures (11,480 wrong values) | High | Analysis |
| 728 | Null pointer dereference should throw TypeError, not trap | High | Feature |

## Issues Updated (residual counts)

| # | Title | Old CE | New CE | Trend |
|---|-------|--------|--------|-------|
| 697 | Struct type mismatch | 813 | 944 | Increased (more tests) |
| 698 | Call type mismatch | 1,044 | 1,250 | Increased (more tests) |
| 704 | Immutable global | 284 | 240 | Improved |
| 705 | Stack underflow | 361 | 362 | Stable |
| 719 | Stack fallthrough | 310 | 103 | Improved significantly |

---

## Recommended Priority Order

1. **#726** (critical) -- Fix the 1,948-test regression first. This is the only issue that recovers previously-passing tests.
2. **#727** (high) -- Sub-classify the 11,480 assertion failures to identify the next high-impact codegen improvements.
3. **#728** (high) -- Convert 1,604 null pointer traps to catchable TypeErrors.
4. Continue working existing ready issues from the dependency graph.

## Net Assessment

CE count improved by 1,053 (19% reduction), which is good progress. However, the 512-test pass regression (driven primarily by the #695/#706 interaction) needs immediate attention. Once #726 is fixed, we should see pass count recover to ~16,668+ (baseline 15,232 + recovered 1,948 minus overlap).
