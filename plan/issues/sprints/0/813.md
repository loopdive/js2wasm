---
id: 813
title: "- gen.next is not a function (1,164 tests)"
status: done
created: 2026-03-27
updated: 2026-04-14
completed: 2026-03-26
priority: critical
feasibility: medium
goal: iterator-protocol
test262_fail: 1164
---
# #813 -- gen.next is not a function (1,164 tests)

## Problem

1,164 tests fail with `gen.next is not a function [in test wrapper]`. The generator object returned by calling a generator function doesn't expose a `.next()` method accessible through the externref interface.

## Breakdown by category

| Category | Count |
|---------|-------|
| language/statements | 734 |
| language/expressions | 380 |
| language/arguments-object | 50 |

## Root cause

The generator protocol returns an object but the `.next` method isn't accessible via the standard externref property lookup. Either:
1. The generator result struct doesn't have a `next` field
2. The `next` field exists but isn't accessible through externref (missing extern.convert_any)
3. The generator function returns externref but the test wrapper calls `.next()` on it expecting a JS object with a next method

## Implementation context

The runtime (`src/runtime.ts:126`) has a correct `__create_generator(buf)` that returns `{next(), return(), throw(), [Symbol.iterator]()}`. Generator compilation works in 3 places:
- `src/codegen/literals.ts:937` — generator methods in object literals
- `src/codegen/closures.ts:1369` — generator closures
- `src/codegen/statements.ts:5261,5400` — generator function declarations

All paths eagerly evaluate the body, collect yields into `__gen_buffer`, then call `__create_generator(__gen_buffer)`.

## Likely root causes

1. **Generator function call not reaching `__create_generator`**: The function is compiled but when called, it may return before the `__create_generator` call (e.g., early return, exception, or wrong block structure)
2. **Generator not registered in `ctx.generatorFunctions`**: If the function isn't in this set, it won't get the generator compilation treatment and will be compiled as a normal function
3. **Calling convention mismatch**: The test wrapper calls the generator function and expects to call `.next()` on the result. If the result is an externref wrapping a Wasm struct instead of the JS object from `__create_generator`, `.next` won't be found
4. **Missing `extern.convert_any`**: The `__create_generator` returns externref, but if it's not properly converted when returned to the test harness

## Fix approach

1. Add test262 reproduction cases that call generator functions and check `.next()`
2. Check if `generatorFunctions.has()` catches all generator function patterns in test262 code (arrow generators? computed method names?)
3. Verify the return value from generator functions is the `__create_generator` result (not the last yield value or void)
4. Check that function* declarations at module level get the generator treatment

## Files to modify
- `src/codegen/statements.ts` — generator function compilation paths (~5261, ~5400)
- `src/codegen/index.ts` — generator function detection (~9772, ~10619)
- `src/codegen/expressions.ts` — generator function calls

## Acceptance criteria
- `gen.next()` callable on generator function results
- `gen.next().value` and `gen.next().done` accessible
- 1,164 tests unblocked

## Complexity: M
