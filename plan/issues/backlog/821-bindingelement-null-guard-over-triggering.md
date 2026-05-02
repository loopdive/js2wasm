---
id: 821
title: "BindingElement null guard over-triggering"
status: ready
created: 2026-03-27
updated: 2026-04-28
priority: critical
feasibility: medium
reasoning_effort: high
goal: core-semantics
parent: 779
test262_fail: 537
---
# #821 -- BindingElement null guard over-triggering (537 fail)

## Problem

The null guard emitted for destructuring binding elements triggers too aggressively — it throws TypeError on values that are valid but happen to be falsy or have unexpected Wasm types. This causes 537 tests to fail with wrong values or unexpected errors during destructuring.

## ECMAScript spec reference

- [§14.3.3 Runtime Semantics: KeyedBindingInitialization](https://tc39.es/ecma262/#sec-runtime-semantics-keyedbindinginitialization) — step 3: initializer applied when value is undefined, not when null


## Acceptance criteria

- 537 destructuring-related assertion failures fixed
- No regressions in other destructuring tests

## Investigation Notes (2026-03-27)

The 542 null_deref failures in test262 results are NOT caused by the null guard
over-triggering. Investigation showed:

1. The null guard in `emitNullGuard` and `destructureParamObject` works correctly --
   it only fires for `ref_null` types and only when the ref IS actually null at runtime.
2. Default parameter initialization runs BEFORE destructuring, so the null guard
   correctly finds non-null values after defaults are applied.
3. All tested patterns (object/array destructuring, nested destructuring, class methods,
   function params with defaults) work correctly in equivalence tests.
4. The 542 null_deref failures are distributed across: expressions (266), statements (169),
   eval-code (98), arguments-object (5), rest-parameters (2), others (2).
5. 371 of 542 are in `dstr/` test paths -- mostly generated tests using iterator protocol
   (`Symbol.iterator`), async generators, and rest patterns (`[...[...x]]`).
6. The root causes are missing iterator protocol support and complex pattern compilation,
   NOT the null guard mechanism itself.

This issue should be re-scoped or broken into specific sub-issues:
- Iterator protocol for array destructuring (Symbol.iterator support)
- Async generator destructured parameters
- Rest element with nested destructuring
