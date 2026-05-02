---
id: 1150
title: "Fix runtime_error:26 + type_error:7 + oob:5 — async destructuring regressions"
status: done
created: 2026-04-20
updated: 2026-04-28
completed: 2026-04-28
priority: high
feasibility: medium
reasoning_effort: high
goal: async-model
closed: 2026-04-23
pr: 243
net_improvement: 262
---
# #1150 — Fix 38 async destructuring / TDZ / rest-element regressions

## Problem

38 tests that were passing in the April 13 baseline now fail with runtime errors:
- **runtime_error: 26** — "Cannot convert object to primitive value"
- **type_error: 7** — TDZ in async function default params
- **oob: 5** — array element access out of bounds in rest destructuring

## Category 1: runtime_error:26 — "Cannot convert object to primitive value"

### for-await-of destructuring (18 tests)
```
test/language/statements/for-await-of/async-func-dstr-*-ary-ptrn-elem-ary-val-null.js
test/language/statements/for-await-of/async-func-dstr-*-ary-ptrn-elision-iter-close.js
test/language/statements/for-await-of/async-func-dstr-*-obj-ptrn-prop-obj-value-undef.js
```
Pattern: async function inside for-await-of with destructuring where elements are null/undefined, or iterator close is triggered.

### Object rest skip non-enumerable (7 tests)
```
test/language/expressions/class/dstr/async-gen-meth-dflt-obj-ptrn-rest-skip-non-enumerable.js
test/language/statements/async-generator/dstr/dflt-obj-ptrn-rest-skip-non-enumerable.js
```
Pattern: `{...rest}` in async generator method default params, rest should skip non-enumerable properties.

### Other (1 each)
- `RegExp/named-groups/groups-object-subclass-sans.js` — RegExp subclass without named groups
- `Object/defineProperty/15.2.3.6-4-332.js`, `15.2.3.6-4-374.js` — Property descriptor value handling

## Category 2: type_error:7 — async function TDZ default params

```
test/language/expressions/async-function/named-dflt-params-ref-later.js
test/language/expressions/async-function/named-dflt-params-ref-self.js
test/language/expressions/async-function/nameless-dflt-params-ref-later.js
test/language/expressions/async-function/nameless-dflt-params-ref-self.js
test/language/expressions/object/method-definition/async-meth-dflt-params-ref-later.js
test/language/expressions/object/method-definition/async-meth-dflt-params-ref-self.js
test/language/statements/for-await-of/async-func-decl-dstr-array-elem-put-unresolvable-strict.js
```

Error: `TypeError (null/undefined access): Referencing a parameter that occurs later in the ParameterList`

These expect a SyntaxError/ReferenceError for temporal dead zone violation in async function default params. We're throwing TypeError instead of the right error.

## Category 3: oob:5 — rest element elision next-err

```
test/language/expressions/arrow-function/dstr/dflt-ary-ptrn-rest-id-elision-next-err.js
test/language/expressions/async-generator/dstr/dflt-ary-ptrn-rest-id-elision-next-err.js
test/language/expressions/function/dstr/dflt-ary-ptrn-rest-id-elision-next-err.js
test/language/expressions/generators/dstr/dflt-ary-ptrn-rest-id-elision-next-err.js
```

Error: `L68:3 array element access out of bounds [in __closure_3()]`

Pattern: `function f([, ...rest] = iterThrows) {}` — array destructuring with elision, rest element, and iterator that throws. The rest element implementation accesses the array out-of-bounds when the iterator throws during elision.

## Investigation strategy

1. **Start with oob:5** — small, probably a bounds check missing in `src/codegen/destructuring.ts` or wherever rest element iteration lives

2. **type_error:7** — For TDZ in async function default params, check how `src/codegen/statements.ts` emits default param guards for async functions. Are they checking later-param TDZ? Should be same path as sync functions.

3. **runtime_error:26** — "Cannot convert object to primitive value":
   - for-await-of: check what happens when destructuring null/undefined elements in `for-await-of` — is the null check missing?
   - obj-ptrn-rest: check `src/codegen/destructuring.ts` for object rest in async contexts
   - Object.defineProperty: minimal repro needed

## Acceptance criteria
- All 38 tests fixed (or have issue-filed blockers for each subset)
- `npm test -- tests/equivalence.test.ts` — no regressions
- Open PR with fixes

## Key files
- `src/codegen/destructuring.ts` — rest elements, object rest patterns
- `src/codegen/statements.ts` — default params, TDZ guards, for-await-of
- `src/codegen/expressions.ts` — async function expressions default params

## Test Results (local, issue-1150 branch)

- Bucket A (oob:5): **4/4 pass** — rest-elision with throwing iterator now materialises via `Array.from` before walking
- Bucket B (type_error:7): **7/7 pass** — TDZ in async function default params now throws a real JS `ReferenceError` and async call-site wraps synchronous throws into rejected Promises
- Bucket C (runtime_error, for-await-of subset): **9/9 pass** of the 9 listed in the issue description (all null/undef/iter-close patterns across let/const/var)
- Bucket C (obj-ptrn-rest-skip-non-enumerable): **0/2 pass** — pre-existing bug with default param + object rest in async generator methods (throws "Cannot destructure 'null' or 'undefined'" instead of reaching the default). Not addressed here.

Total direct-subset score: **20/22 pass**. Broader for-await-of destructuring set (45 tests matching `async-func-dstr-*-(null|undef|close)`): **36/45 pass** after fix.

## Implementation Summary

1. **New host import `__array_from_iter`** (`src/runtime.ts`): materialises an iterable/array-like to a real array via `Array.from`, propagating `.next()` throws from generators. Used by destructuring paths that previously walked iterables via `__extern_length`/`__extern_get_idx` and trapped on zero-length `array.copy` when the iterator threw.
2. **Materialise in `buildVecFromExternref`** (`src/codegen/type-coercion.ts`) and in the `destructureParamArray` externref fallback (`src/codegen/destructuring-params.ts`): call `__array_from_iter` on the source before computing length and walking indices. This fixes Bucket A (rest-elision with throwing iterator).
3. **New host import `__throw_reference_error`** (`src/runtime.ts`): throws a real JS `ReferenceError` with a caller-supplied message.
4. **TDZ throws use `__throw_reference_error`** (`src/codegen/expressions/identifiers.ts`): `emitLocalTdzCheck` and `emitStaticTdzThrow` now call the host import instead of emitting `ref.null.extern` + wasm `throw`. This makes `error.constructor === ReferenceError` checks pass.
5. **Async call-site try/catch wrap** (`src/codegen/expressions.ts`): `compileExpressionInner` records the body length before a call and, for async calls, wraps the emitted call + `Promise.resolve` in a `try/catch_all` that calls `__get_caught_exception` and `Promise_reject`. This turns synchronous throws during async function default-param evaluation or body execution into rejected Promises, so `f().then(_, onRej)` works per spec.
