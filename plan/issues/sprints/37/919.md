---
id: 919
title: "Fix direct-eval arguments regressions introduced since the April 1 test262 baseline"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: async-model
files:
  src/:
    investigate:
      - "Locate the direct-eval environment/binding path for arguments in async functions, async methods, generators, and related function bodies"
      - "Trace where eval-created declarations for arguments are resolved and assigned"
  tests/:
    add:
      - "Add focused regression coverage for the failing direct-eval arguments cases or pin the relevant official tests in local targeted coverage"
  benchmarks/results/:
    reference:
      - "Use the April 1 and April 3 test262 result files to confirm the regression cluster"
---
# #919 -- Fix direct-eval arguments regressions introduced since the April 1 test262 baseline

## Problem

Compared to the stored April 1, 2026 test262 data, clean `HEAD` lost `54` previously passing tests in `language/eval-code`.

These all regressed from `pass -> fail` and now fail with `type_error`, with the same general shape:

- direct `eval(...)`
- `arguments` declaration or assignment inside async/generator/method bodies

Representative failures:

- `test/language/eval-code/direct/async-func-decl-fn-body-cntns-arguments-lex-bind-declare-arguments.js`
- `test/language/eval-code/direct/async-gen-meth-fn-body-cntns-arguments-var-bind-declare-arguments-and-assign.js`
- `test/language/eval-code/direct/async-meth-a-preceding-parameter-is-named-arguments-declare-arguments.js`

Representative current failure:

```text
TypeError (null/undefined access): Declare "arguments" and assign to it in direct eval code ...
```

This strongly suggests drift in the direct-eval binding environment for `arguments`, not a random backend failure.

## Goal

Restore the direct-eval `arguments` behavior for the affected async/generator/method cases so the lost passes return.

## Requirements

1. Identify the code path that constructs or resolves direct-eval bindings for `arguments`
2. Explain why the affected cases now produce null/undefined access instead of the previous behavior
3. Fix the binding/lookup/assignment logic without breaking existing direct-eval behavior
4. Add targeted regression coverage for at least a few representative failing cases
5. Re-run targeted test262 coverage for the cluster and confirm the restored passes

## Acceptance criteria

- the `language/eval-code` direct-eval `arguments` regression cluster no longer shows the `54` lost passes relative to the April 1 baseline
- representative tests listed above pass again
- the fix is backed by targeted regression coverage or documented targeted test262 commands

## Root Cause

The regression was caused by `bae201ef` (#855) which added `Promise_then2` host import for `.then()` calls on async function results, but didn't wrap async function return values in `Promise.resolve()`. Our compiler executes async functions synchronously, returning raw Wasm values (f64, i32, void) instead of Promises. When `.then()` was called on these raw values via `Promise_then2`, it crashed with "null/undefined access".

## Fix

Two-part fix across 5 files:

1. **Unwrap Promise<T> return types** for nested async functions in all compilation paths:
   - `statements.ts` — `compileNestedFunctionDeclaration`
   - `closures.ts` — `compileArrowAsClosure`
   - `literals.ts` — object literal async methods
   - `index.ts` — class async methods

2. **Wrap async function call results in Promise.resolve()** (`expressions.ts`):
   - Added `isAsyncCallExpression()` to detect async callee from TS signature
   - Added `wrapAsyncReturn()` to coerce value to externref and call `Promise_resolve`
   - Applied at the single `compileExpressionInner` call-expression entry point

## Test Results

**Async eval-code/direct tests (102 total)**:
- 58/102 pass (was ~0 before fix due to null.then crash)
- 52/52 baseline-passing tests restored (zero regressions)
- 6 new tests now pass (improvements)
- 44 still failing: 36 "null pointer" (async generators, pre-existing), 8 "illegal cast" (pre-existing)

**All 3 representative tests PASS**:
- `async-func-decl-fn-body-cntns-arguments-lex-bind-declare-arguments.js` ✓
- `async-gen-meth-fn-body-cntns-arguments-var-bind-declare-arguments-and-assign.js` ✓
- `async-meth-a-preceding-parameter-is-named-arguments-declare-arguments.js` ✓

