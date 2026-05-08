---
id: 1361
sprint: 51
title: "spec gap: Array.prototype.sort — comparator validation, stability, ToString fallback (~46 fails)"
status: in-progress
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays
goal: spec-completeness
---
# #1361 — Array.prototype.sort: comparator + stability + ToString default

## Problem

`built-ins/Array/prototype/sort` — 46 fails, mostly assertion_fail; many test the
comparator-validation contract or default ordering.

Spec §23.1.3.30 (Array.prototype.sort) mandates:

1. **Comparator type-check** — if `comparefn` is provided and not callable, throw
   `TypeError` *before* any sort work begins. Today our `compileArraySort` (line 4861
   in `src/codegen/array-methods.ts`) accepts any callable-typed expression and silently
   degrades to default ordering when types mismatch.
2. **Default ordering = ToString comparison** — when `comparefn` is undefined, the spec
   says compare strings: `xString = ToString(x); yString = ToString(y); xString < yString`.
   Today we use `f64.lt` for numeric arrays — so `[10, 9, 1].sort()` returns
   `[1, 9, 10]` (numeric ordering), but spec says `[1, 10, 9]` (lexicographic).
3. **Stability** — sort must be stable for elements that compare equal. `timsort.ts`
   IS stable, but the entry path may dispatch to a non-stable implementation when
   a comparator is present and the receiver is a typed `f64[]`.
4. **NaN ordering** — spec says NaN values sort to the end (in default ordering).
   `f64.lt(NaN, x)` returns false for any x, so NaN can settle in arbitrary positions
   under a default sort.
5. **Sparse + undefined ordering** — undefined elements sort to the end *after* sorting
   the rest; sparse holes sort to the very end *after* undefined.

## Acceptance criteria

1. `built-ins/Array/prototype/sort/comparefn-nonfunction-call-throws.js` passes
   (TypeError before sort).
2. `built-ins/Array/prototype/sort/S15.4.4.11_A1.1_T1.js` passes (default lexicographic).
3. `built-ins/Array/prototype/sort/sort-tostring.js` passes (uses ToString of elements).
4. `built-ins/Array/prototype/sort/stability-2048-elements.js` passes.
5. `built-ins/Array/prototype/sort/comparefn-nonfunction-call-throws.js` passes.
6. Pass-rate for `built-ins/Array/prototype/sort` rises from ~50% to ≥85%; **+30 net passes**.

## Files to modify

- `src/codegen/array-methods.ts` — `compileArraySort` (line 4861).
- `src/codegen/timsort.ts` — verify stability for the comparator-provided path.

## Implementation Plan

### Root cause

- `compileArraySort` does not emit a `IsCallable(comparefn)` runtime check.
- Default ordering uses `f64.lt` regardless of whether a comparator is passed.

### Approach

#### A. Comparator type-check

Mirror the pattern in `emitCallbackTypeCheck` (line ~73 of array-methods.ts):

```ts
if (callExpr.arguments.length >= 1) {
  if (emitCallbackTypeCheck(ctx, fctx, callExpr, "Array.prototype.sort")) {
    fctx.body.push({ op: "unreachable" } as unknown as Instr);
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }
}
```

Note: if comparefn is `undefined` literally (not missing), spec also accepts that as
"no comparator". Check for `undefined` keyword in addition to missing args.

#### B. Default ordering — ToString comparison

When no comparator is provided, emit the default-ordering helper:

For typed `f64[]` arrays, this means we cannot use `f64.lt`. Two options:

- **Option 1 (simplest)**: when no comparator, fall through to a host import
  `__sort_default(arrExternref) -> arrExternref`. Cost: round-trip to externref.
- **Option 2 (preferred)**: emit a Wasm-native string comparator. For each pair, call
  `__num_to_string_compare(a: f64, b: f64) -> i32` (returns -1/0/+1). The host stringifies
  both numbers and lex-compares. Avoids array round-trip.

Pick Option 2 — `__num_to_string_compare` is one host import call per pair.

For string arrays: use `__string_compare(a, b) -> i32`.

For mixed externref arrays: use `__default_sort_compare(a, b) -> i32`.

#### C. NaN handling in user comparator

Spec §7.2.13: if `comparefn(x, y)` returns NaN, treat as 0 (no swap). Today the
returned f64 from `call_ref` is compared directly; if user returns `NaN`, our
`f64.lt 0` is false and `f64.gt 0` is also false → treated as 0 by accident, but
the timsort traverses both branches. Verify and add an explicit `NaN → 0` step.

#### D. Stability for comparator path

If timsort is invoked correctly (preserve original index on equal compare), this is
already correct. Sanity-check by reading `compileArraySort` and tracing the path
when a comparator is present.

#### E. Undefined and sparse handling

Per spec algorithm:
1. Partition the array into "non-undefined", "undefined", "holes".
2. Sort non-undefined.
3. Append undefineds.
4. Set length back (no-op for typed arrays, matters for sparse).

For typed `f64[]` arrays, no `undefined` is possible (all values are f64). For
externref arrays, partition before timsort.

### Edge cases

- `[].sort()` — return same empty array.
- `[NaN, NaN].sort()` — both NaN, comparator returns 0, stable order.
- Sort comparator throws — propagate exception, leave array in whatever state.
- Sort comparator returns BigInt — coerce to number; if cannot, TypeError.
- `Array.prototype.sort.call(arrayLike, cb)` — needs to write back via `Set(O, k, v)`,
  not direct array writes. Pure Wasm path may be infeasible — fall back to
  `__proto_method_call`.

### Test262 sample

- `test262/test/built-ins/Array/prototype/sort/comparefn-nonfunction-call-throws.js`
- `test262/test/built-ins/Array/prototype/sort/S15.4.4.11_A1.1_T1.js`
- `test262/test/built-ins/Array/prototype/sort/sort-tostring.js`
- `test262/test/built-ins/Array/prototype/sort/stability-2048-elements.js`
- `test262/test/built-ins/Array/prototype/sort/comparefn-symbol-throws.js`

### Estimated impact

+30 passes for sort; secondary lifts from now-correct default ordering visible in user code.
