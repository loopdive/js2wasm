---
id: 1359
sprint: 51
title: "spec gap: Array.prototype.{splice,slice,concat,toSpliced,toReversed} — @@species, sparse handling, IsConcatSpreadable (~150 fails)"
status: in-progress
created: 2026-05-08
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arrays
goal: spec-completeness
---
# #1359 — Array.prototype.{splice,slice,concat,…}: @@species + sparse + IsConcatSpreadable

## Problem

`built-ins/Array/prototype/{slice,splice,concat,toSpliced,toReversed}` failure breakdown:

| method     | fails | top categories                       |
|------------|-------|--------------------------------------|
| splice     | 70    | 25 assertion_fail, 25 other, 10 illegal_cast |
| slice      | 60    | 35 other, 17 assertion_fail, 6 oob   |
| concat     | 54    | 40 assertion_fail, 6 oob, 4 other    |
| toSpliced  | 11    | 7 assertion_fail, 2 oob, 2 other     |
| toReversed | 6     | 4 assertion_fail, 2 other            |

Representative samples:

- `slice/S15.4.4.10_A1.1_T4.js` → "var arr = x.slice(5,5); arr is Array object. Actual: null"
- `concat/S15.4.4.4_A3_T1.js` → "L55:3 array element access out of bounds [in test()]"
- `concat/create-species-non-extensible.js` → expects TypeError; we don't throw
- `concat/is-concat-spreadable-val-undefined.js` → IsConcatSpreadable not honored
- `slice/create-proxy.js` → expects subclass via @@species

Spec gaps:

1. **@@species** (§7.3.24, §23.1.3.x) — `slice`, `splice`, `concat`, `toSpliced`,
   `toReversed`, `toSorted` MUST construct the result via `ArraySpeciesCreate(O, length)`
   which calls `O.constructor[@@species]` if present. Today `compileArraySlice`
   (line 3244) emits `struct.new $vec` directly — wrong type for a subclass receiver,
   wrong identity for the Array constructor returns.
2. **`x.slice(a, a)` returning typed null when length is 0** — empty slice returns
   `ref_null $vec`, but tests assert `Array.isArray(result) === true`. The non-null
   `array.new_default(0)` path is never exercised because `sliceLen == 0` short-circuits
   to a null vec. Fix: always emit a non-null empty vec.
3. **IsConcatSpreadable (§23.1.3.2.1)** — `concat` must check
   `obj[@@isConcatSpreadable]` first. If undefined, fall back to IsArray. If the value
   is set and falsy → spread off (treat as a single element). We never read this symbol.
4. **Sparse holes in slice/splice/concat** — must `HasProperty(O, k)` before copying;
   today we always `array.copy` the underlying typed array (which materializes
   `undefined` defaults as `null`/`0` depending on element type — visible as
   `assert.sameValue(result[2], undefined)` failing because we have a typed `0`).
5. **Splice deleteCount coercion** — `splice(start)` with no deleteCount → spec says
   `len - actualStart`. With explicit `undefined` → spec says 0. We treat `undefined`
   as `len - start` (#3658 path).
6. **Concat oob on receiver-with-mixed-elem-types** — `[1].concat([2,3])` works, but
   `[1, "a"].concat(...)` mixes `f64`/`externref` element types and currently traps oob.

## Acceptance criteria

1. `built-ins/Array/prototype/slice/S15.4.4.10_A1.1_T4.js` passes (`x.slice(5,5)` returns
   non-null empty Array).
2. `built-ins/Array/prototype/concat/is-concat-spreadable-val-undefined.js` passes.
3. `built-ins/Array/prototype/concat/create-species-non-extensible.js` passes
   (TypeError when @@species creates a non-extensible array).
4. `built-ins/Array/prototype/splice/S15.4.4.12_A6.1_T2.js` passes
   (`splice(0)` removes all, `splice(0, undefined)` removes none).
5. `built-ins/Array/prototype/slice/create-proxy.js` passes
   (subclass result via @@species).
6. Pass-rate for these 5 methods rises from ~32% to ≥65%; **+100 net passes**.

## Files to modify

- `src/codegen/array-methods.ts`:
  - `compileArraySlice` (line 3244) — always emit non-null empty vec; add @@species fast path.
  - `compileArrayConcat` (line 3321) and `compileArrayConcatExtern` (line 3436) —
    add IsConcatSpreadable check; for static-type-known-Array fast path, skip the lookup.
  - `compileArraySplice` (line 3658) — fix deleteCount=undefined semantics.
- `src/runtime.ts` — add `__array_species_create(O: externref, length: f64) -> externref`
  helper that does the spec dance, OR inline it.

## Implementation Plan

### Root cause

These methods predate sprint 50's species/iterator work. They emit fast Wasm but
skip the spec preamble. For Array-typed receivers, ~95% of tests don't notice
because the receiver IS `Array` — so they pass. The failing tests are exactly the
ones that exercise the spec preamble (subclass receiver, proxy, custom @@species,
sparse, isConcatSpreadable).

### Approach

#### A. Empty-slice null→non-null fix (1-line)

In `compileArraySlice` (line 3302), unconditionally emit
`array.new_default(sliceLen)` even when `sliceLen == 0`. Today `array.new_default(0)`
is fine in Wasm — produces a zero-length array. The bug is that the surrounding
`struct.new` then receives a `ref null $arr`, and a downstream consumer
sees `null`. Fix: keep the local on the stack (already done) and ensure the path
always wraps in `struct.new`.

But `slice/A1.1_T4` says "actual: null" for the *whole vec*, suggesting the vec is
returned as `ref.null` somewhere. Trace: `sliceLen=0` → `array.new_default(0)` → set
to `newData` local (typed `ref null $arr`). Then `local.get newData` + `ref.as_non_null`
+ `struct.new $vec` should produce a non-null vec. The "null" must come from the
caller pattern `var arr = x.slice(5,5); arr is Array object. Actual: null` — so probably
the property `Array.isArray` returns false because we don't set up the vec's
`__isArray` brand. Verify by reading the test and tracing: if it's Array.isArray,
that's a separate bug — see #1335 work or carve out as #1360 fix.

For now: assert the test failure source and patch.

#### B. ArraySpeciesCreate (spec §7.3.24)

Add a helper `emitSpeciesCreate(ctx, fctx, recvLocal, lenLocal, vecTypeIdx, arrTypeIdx)`:

```ts
// 1. If IsArray(recv) is false → return new Array(len). [we know it's true]
// 2. C = recv.constructor; if C is Array (the canonical) → return new Array(len) (fast).
// 3. Else: invoke __array_species_create(recv, len) via host import; result is externref.
//    Return that as `(ref null $vec)` after coerceType.
```

For the static-Array fast path: emit `array.new_default + struct.new` (current behavior).
For the slow path (receiver static type is unknown / class extends Array): emit a
`call $__array_species_create` and accept an externref result. Most concat/slice
calls in user code go through fast path; only test262 stresses slow path.

Add `__array_species_create` to runtime.ts:

```ts
__array_species_create(o, length) {
  const C = (typeof o === 'object' && o !== null && o.constructor) || Array;
  let S = C[Symbol.species];
  if (S === undefined || S === null) S = Array;
  if (typeof S !== 'function') throw new TypeError(...);
  return new S(length);
}
```

#### C. IsConcatSpreadable (spec §23.1.3.2.1)

In `compileArrayConcat`, before the per-arg branch:

```wasm
;; if Array (typed): spread = true (skip lookup)
;; else: call __is_concat_spreadable(arg) -> i32
;;   1 = spread, 0 = single, -1 = throw (rare)
```

Runtime helper:

```ts
__is_concat_spreadable(v) {
  if (v === null || typeof v !== 'object') return 0;
  const sym = v[Symbol.isConcatSpreadable];
  if (sym !== undefined) return sym ? 1 : 0;
  return Array.isArray(v) ? 1 : 0;
}
```

#### D. splice(start, undefined) fix

In `compileArraySplice` (line 3669), when `arguments.length === 1`, set `deleteCount = len - start`.
When `arguments.length >= 2`, evaluate the deleteCount expression — if the runtime value
is `undefined` (NaN sentinel from f64 coercion), `ToInteger(undefined)` is 0, NOT
`len - start`. Fix:

```ts
if (callExpr.arguments.length === 1) {
  // deleteCount = len - actualStart
} else {
  // ToInteger(args[1]); NaN -> 0; +Infinity -> 2^53-1; -Infinity -> 0
  // (today we use i32.trunc_sat_f64_s which already maps NaN→0, +∞→i32.MAX, but
  //  we need to clamp against len-start, not let it overflow)
}
```

The bug today: when args[1] is the JS literal `undefined` (NaN in f64), we hit the
else branch and `i32.trunc_sat_f64_s(NaN)` = 0 — that's actually correct! Verify
the test case is hitting a different path (perhaps `0-arg splice`?). Re-read
`compileArraySplice` lines 3669–3700 carefully and adjust.

#### E. Sparse hole preservation

For `slice` and `splice`: spec says `HasProperty(O, k)` before each `Get(O, k)`. For
typed Wasm vecs, all indices have a value (no holes possible at the WasmGC level —
holes come from sparse/host arrays). For `__vec_*` typed receivers we can skip this
check (no holes possible). For host-array receivers, the existing `__proto_method_call`
bridge handles it. Document this in a code comment so future work doesn't forget.

### Edge cases

- `concat([Array.prototype])` — Array.prototype is itself an Array; spread it.
- `slice` on `Symbol.species` returning non-Array constructor — `Array.isArray(result)`
  is false, but `result.length === N` and `result[0]…result[N-1]` are set.
- `splice(0, 2^32)` — clamp to len.
- `concat` when an element has `[[Get]] @@isConcatSpreadable` that throws — propagate.

### Test262 sample

- `test262/test/built-ins/Array/prototype/slice/S15.4.4.10_A1.1_T4.js`
- `test262/test/built-ins/Array/prototype/slice/create-proxy.js`
- `test262/test/built-ins/Array/prototype/concat/is-concat-spreadable-val-undefined.js`
- `test262/test/built-ins/Array/prototype/concat/create-species-non-extensible.js`
- `test262/test/built-ins/Array/prototype/splice/S15.4.4.12_A6.1_T2.js`
- `test262/test/built-ins/Array/prototype/concat/S15.4.4.4_A3_T1.js`

### Estimated impact

+100 net passes. §23.1 climbs further toward 60%.

## Sub-slice decomposition (senior-dev refinement, 2026-05-08)

After reading the failing tests directly (not just the architect's bisect),
the original 5 sub-slices need re-scoping. Several are **blocked on issues
deeper than this codegen path** and won't yield wins from changes inside
`array-methods.ts` alone.

### Slice A — empty-slice "actual: null" — **NOT a slice() bug**

The architect's investigation said `x.slice(5,5)` returns null. Reading
`slice/S15.4.4.10_A1.1_T4.js`:
```js
var arr = x.slice(5, 5);
arr.getClass = Object.prototype.toString;
if (arr.getClass() !== "[object Array]") { /* fail with "Actual: null" */ }
```

The `Actual: null` comes from `arr.getClass()` returning a brand string
that doesn't match `"[object Array]"`, not from `arr` itself being null.
This needs `Object.prototype.toString` brand fidelity for `__vec_*` —
**#1334's territory** (Object.defineProperty descriptor + brand). NOT
fixable inside `compileArraySlice`.

**Disposition:** mark as blocked on #1334. No code change in this issue.

### Slice B — ArraySpeciesCreate (@@species) — **medium scope, ~150 LoC**

The architect's plan is correct: add `__array_species_create` host
helper + inline check in `compileArraySlice` / `compileArraySplice` /
`compileArrayConcat` when the static receiver type isn't `__vec_*`.
For static-Array-typed receivers (the 95% common case), no change —
`struct.new` is fast and correct because `Array[@@species] === Array`.

The slow path (subclass receiver, proxy, custom `@@species`) is rare
in user code; mainly test262. Estimated +10–30 net passes.

**Disposition:** ship as a standalone follow-up. Track as **#1359B**
(open new issue when ready).

### Slice C — IsConcatSpreadable — **already partially handled**

The existing fast-path `compileArrayConcat` only fires when
`resolveArrayInfo(ctx, argTsType)` confirms the arg is a known WasmGC
array type. For `any` / `object` / array-likes with
`Symbol.isConcatSpreadable`, it falls back to
`compileArrayConcatExtern` (host helper `__array_concat_any`). That
host helper calls native `Array.prototype.concat` which respects
`Symbol.isConcatSpreadable` natively.

So most `is-concat-spreadable-*` tests should already work via the
fallback. The ones that fail likely fail at the property assignment
(`item[Symbol.isConcatSpreadable] = undefined`) — a Symbol-key
indexing issue upstream of concat itself.

**Disposition:** investigate which specific tests fail before adding
the spreadable check to the typed fast path. Likely yields fewer
passes than estimated. Track as **#1359C** with concrete failing
tests after re-investigation.

### Slice D — splice deleteCount=undefined — **already correct**

Walked `compileArraySplice` (lines 3658–3735):
- 0-arg → empty array, no mutation ✓ matches spec
- 1-arg → `delCount = len - start` ✓ matches spec
- 2-arg with `undefined` → compiles to NaN → `i32.trunc_sat_f64_s(NaN) = 0`
  ✓ matches `ToInteger(undefined) === 0`

The architect's failing test `splice/S15.4.4.12_A6.1_T2.js` is actually
about `length` being non-writable — needs
`Object.defineProperty(a, 'length', {writable: false})` and
TypeError-on-write semantics. **#1334's territory**, not splice
itself.

**Disposition:** no fix needed in splice. The 25 splice `assertion_fail`
count needs re-bucketing before any fix is attempted.

### Slice E — Sparse hole preservation — **no-op for typed vecs (THIS PR)**

For `__vec_*` typed receivers, no holes are possible at the WasmGC
level. For host-array receivers, the existing `__proto_method_call`
bridge handles sparse holes correctly. This slice is a code comment,
not a behaviour change. Ship in this PR as documentation so future
reviewers don't re-investigate the same paths.

### Re-scoped follow-up plan

Given the corrected analysis, the realistic yield from this issue is:

| Slice | Yield | Status |
|-------|-------|--------|
| A | 0 (blocked on #1334) | doc-only, no code change |
| **B** | +10–30 net passes | **track as #1359B follow-up** |
| C | TBD (likely <10) | **track as #1359C follow-up** |
| D | 0 (already correct) | doc-only, no code change |
| **E** | 0 (no-op for typed vecs) | **doc comment THIS PR** |

Total realistic yield from #1359 work alone is closer to **+10–30 net
passes** (Slice B), not the original +100 estimate. The +100 assumed
all 5 slices were tractable in `array-methods.ts`; 3 of them require
fixes elsewhere (#1334 Object brand fidelity + Symbol-key indexing).

### Action items

1. **This PR**: Slice E doc comment + this re-scoped sub-slice plan
2. **#1359B follow-up**: implement Slice B (@@species), separately
3. **#1359C follow-up**: re-investigate Slice C with concrete failing
   tests
4. **Cross-issue note on #1334**: several Array.prototype tests block
   on it
