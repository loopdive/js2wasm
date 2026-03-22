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

## Assertion Failure Sub-classification (#727)

Total assertion failures with "assert #" pattern: **11,480**

### Broad Groups

| Group | Count | Pct |
|-------|------:|----:|
| Error throws | 4,152 | 36.2% |
| Object metadata | 1,250 | 10.9% |
| Class features | 1,166 | 10.2% |
| Prototype chain | 463 | 4.0% |
| Array operations | 444 | 3.9% |
| Object operations | 405 | 3.5% |
| Type coercion | 398 | 3.5% |
| Temporal | 367 | 3.2% |
| Type checks | 353 | 3.1% |
| Async | 350 | 3.0% |
| Function | 234 | 2.0% |
| Expressions | 216 | 1.9% |
| Property descriptors | 173 | 1.5% |
| eval | 173 | 1.5% |
| Operators | 154 | 1.3% |
| Generators | 146 | 1.3% |
| Numeric | 115 | 1.0% |
| Iterators | 100 | 0.9% |
| Statements | 97 | 0.8% |
| Iteration | 94 | 0.8% |
| Scoping | 91 | 0.8% |
| RegExp | 81 | 0.7% |
| Date | 73 | 0.6% |
| TypedArray/DataView | 60 | 0.5% |
| String operations | 51 | 0.4% |
| Proxy/Reflect | 42 | 0.4% |
| Other | 42 | 0.4% |
| Symbols | 38 | 0.3% |
| Annex B | 38 | 0.3% |
| Error handling | 34 | 0.3% |
| arguments | 32 | 0.3% |
| BigInt | 17 | 0.1% |
| Collections | 10 | 0.1% |
| Value checks | 8 | 0.1% |
| JSON | 7 | 0.1% |
| Strict mode | 4 | <0.1% |
| Locale | 2 | <0.1% |

### Detailed Sub-patterns (>200 tests)

| Sub-pattern | Count | Pct | Existing issue |
|-------------|------:|----:|----------------|
| assert.throws(TypeError) | 1,821 | 15.9% | #726, #728 |
| class feature (generic assert) | 1,161 | 10.1% | **NEW #729** |
| assert.throws(ReferenceError) | 846 | 7.4% | #723 (TDZ subset) |
| assert.throws(Test262Error) [expected exc. not thrown] | 708 | 6.2% | **NEW #730** |
| .name property | 558 | 4.9% | **NEW #731** |
| hasOwnProperty | 520 | 4.5% | **NEW #732** |
| .prototype check | 461 | 4.0% | #678 |
| assert.throws(RangeError) | 442 | 3.9% | **NEW #733** |
| Temporal (generic assert) | 367 | 3.2% | #661 |
| Array method (generic assert) | 343 | 3.0% | **NEW #734** |
| async iteration (generic assert) | 329 | 2.9% | **NEW #735** |
| assert.throws(SyntaxError) | 316 | 2.8% | **NEW #736** |
| undefined handling | 276 | 2.4% | **NEW #737** |
| instanceof check | 276 | 2.4% | **NEW #738** |
| Object.defineProperty (generic assert) | 262 | 2.3% | **NEW #739** |

### Key Findings

1. **Error throws dominate** (36.2%): The compiler does not throw the correct error types in many cases. TypeError alone accounts for 15.9% of all assertion failures.

2. **Class features are a major gap** (10.1%): 1,161 tests fail on class body semantics -- field initialization, method definition, static members, class expressions. NOT prototype-related (those are separate).

3. **ReferenceError throws** (7.4%): 846 tests expect ReferenceError. TDZ violations (#723) are a subset; the rest involve undeclared variable access and strict mode identifier restrictions.

4. **Test262Error throws** (6.2%): 708 tests use `assert.throws(Test262Error, fn)` meaning the test expected an exception that was never thrown. Indicates missing runtime exception paths.

5. **.name property** (4.9%): 558 tests check Function.name or class name. The compiler likely does not set .name on function/class objects.

6. **hasOwnProperty** (4.5%): 520 tests check property ownership. The object model may not distinguish own vs. inherited properties correctly.

7. **RangeError** (3.9%): 442 tests expect RangeError for out-of-bounds arguments, stack overflow, etc. Missing range validation in built-in methods.

### Top Test Categories

| Category | Assertion fails |
|----------|------:|
| language/statements | 3,004 |
| language/expressions | 2,809 |
| built-ins/Array | 1,035 |
| built-ins/Temporal | 967 |
| built-ins/Object | 853 |
| built-ins/DataView | 306 |
| annexB/language | 302 |
| built-ins/RegExp | 280 |
| built-ins/Date | 237 |
| built-ins/String | 217 |
| built-ins/Iterator | 165 |
| built-ins/Function | 137 |
| built-ins/Proxy | 122 |
| built-ins/Number | 99 |

### New Issues Created from Sub-classification

| # | Title | Count | Priority |
|---|-------|------:|----------|
| 729 | Class feature codegen gaps | 1,161 | high |
| 730 | Missing exception paths (Test262Error throws) | 708 | high |
| 731 | Function/class .name property | 558 | medium |
| 732 | hasOwnProperty correctness | 520 | medium |
| 733 | RangeError validation in built-ins | 442 | medium |
| 734 | Array method correctness | 343 | medium |
| 735 | Async iteration correctness | 329 | medium |
| 736 | SyntaxError detection at compile time | 316 | medium |
| 737 | Undefined-handling edge cases | 276 | medium |
| 738 | instanceof correctness | 276 | medium |
| 739 | Object.defineProperty correctness | 262 | medium |

---

## Net Assessment

CE count improved by 1,053 (19% reduction), which is good progress. However, the 512-test pass regression (driven primarily by the #695/#706 interaction) needs immediate attention. Once #726 is fixed, we should see pass count recover to ~16,668+ (baseline 15,232 + recovered 1,948 minus overlap).
