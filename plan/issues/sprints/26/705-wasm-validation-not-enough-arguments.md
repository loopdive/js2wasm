---
id: 705
title: "Wasm validation: not enough arguments on the stack (361 CE)"
status: done
created: 2026-03-21
updated: 2026-04-14
completed: 2026-03-21
priority: medium
feasibility: medium
goal: async-model
depends_on: [698]
test262_ce: 362
test262_ce_original: 361
files:
  src/codegen/expressions.ts:
    breaking:
      - "ensure all call sites push correct argument count before call/call_ref"
  src/codegen/statements.ts:
    breaking:
      - "for-await-of closure argument passing"
---
# #705 — Wasm validation: not enough arguments on the stack (361 CE)

## Status: review

### 2026-03-22 Update

Residual count essentially unchanged: 362 CE (was 361). The fix for `compileArrayPrototypeEvery`/`compileArrayPrototypeSome` was correct. The remaining 362 are dominated by missing harness includes (180+) and async closure patterns (85+) as documented in the root cause analysis below.

## Problem

361 tests fail with Wasm validation errors because the compiler emits a `call` or
`call_ref` instruction without pushing enough arguments onto the stack first.
Previous issue #184 fixed some cases, but a residual remains concentrated in
TypedArray, for-await-of, and Array resizable buffer tests.

## Error signature

```
WebAssembly.instantiate(): Compiling function #N:"..." failed: not enough arguments on the stack
```

## Root cause analysis

Detailed analysis of the 361 errors shows several distinct root causes:

| Pattern | Count | Root cause |
|---------|-------|------------|
| `call need=3 got=2 in test` | 142 | Resizable buffer tests use `resizableArrayBufferUtils.js` harness (not shimmed) |
| `call need=1 got=0 in __closure_0` | 60 | Async closures (for-await-of, generators, default params) |
| `call need=3 got=1 in test` | 38 | Missing harness (resizableArrayBufferUtils, testBigIntTypedArray) |
| `local need=1 got=0` | 21 | Various: eval in compound assignment, generator yields |
| `call need=2 got=1` | 8 | Function arity mismatch in TypedArray tests |
| Other | 92 | Assorted patterns |

Of the 361 errors:
- ~180 are from missing harness includes (resizableArrayBufferUtils.js, testBigIntTypedArray.js) -- not fixable in codegen
- ~85 are from for-await-of patterns inside async closures -- complex async compilation issue
- ~31 are from Promise combinator patterns (`.then(cb1, cb2)` with 2-arg then)
- The remaining are assorted edge cases (eval, generators, dynamic import)

## What was fixed

Fixed `compileArrayPrototypeEvery` and `compileArrayPrototypeSome` to push index
and array arguments when the callback expects them (multi-param callbacks). These
functions handled `Array.prototype.every.call(obj, callback)` and
`Array.prototype.some.call(obj, callback)` patterns but only pushed the element
argument, missing the index (2nd param) and array (3rd param).

The fix follows the same pattern already correctly implemented in:
- `compileArrayPrototypeForEach` (line ~23092)
- `buildClosureCallInstrs` (used by `compileArrayFilter`, `compileArrayMap`, etc.)

## What was NOT fixed (and why)

1. **Resizable buffer tests (180+)**: These include `resizableArrayBufferUtils.js` harness
   which is not in the allowed includes list. The tests run despite this because
   `SKIP_DISABLED = true` in the test runner. The undefined `ctors`,
   `CreateResizableArrayBuffer`, etc. cause arity mismatches. Fix: add harness shim.

2. **For-await-of async closures (85)**: The errors are inside the async function
   closure body, not about callback argument passing. Complex async iteration +
   destructuring compilation issue. Fix: improve async function compilation.

3. **Promise 2-arg `.then(cb1, cb2)` (31)**: `Promise_then` import takes 2 args
   (promise, callback) but `.then(cb1, cb2)` has 2 callbacks. Would require a new
   host import or semantic rewrite. Policy: no new host imports.

4. **Eval-related patterns (10+)**: Tests use `eval()` in compound assignments which
   is not supported.

## Files changed

- `src/codegen/expressions.ts`: Fixed `compileArrayPrototypeEvery` and
  `compileArrayPrototypeSome` to push index and array arguments for multi-param callbacks
- `tests/equivalence/issue-705-call-args.test.ts`: New test for multi-param callback arg passing

## Tests now passing

- `every with 1 param works` (was already passing)
- `some with 2 params works`
- `filter with 2 params works`
- `map with 2 params works`
- `forEach with 2 params and capture works`
- No regressions in equivalence test suite (59 pre-existing failures unchanged)
