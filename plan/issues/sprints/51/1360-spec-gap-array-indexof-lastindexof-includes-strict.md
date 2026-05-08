---
id: 1360
sprint: 51
title: "spec gap: Array.prototype.{indexOf,lastIndexOf,includes} — SameValueZero, sparse, fromIndex coercion (~210 fails)"
status: done
created: 2026-05-08
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays
goal: spec-completeness
---
# #1360 — Array.prototype.{indexOf,lastIndexOf,includes}: equality + sparse + fromIndex

## Problem

| method      | fails | top                                |
|-------------|-------|------------------------------------|
| indexOf     | 85    | 80 assertion_fail, 4 oob, 1 type_error |
| lastIndexOf | 86    | 81 assertion_fail, 3 oob, 2 illegal_cast |
| includes    | 11    | 9 assertion_fail, 2 other          |
| **total**   | **182** | mostly assertion_fail               |

Sample:

- `indexOf/15.4.4.14-2-7.js` — `Array.prototype.indexOf.call(objOne, true)` on array-like.
- `indexOf/15.4.4.14-3-21.js` — fromIndex coercion: `Array.prototype.indexOf.call(obj, true, …)`.
- `indexOf/15.4.4.14-9-a-10.js` — `arr.indexOf(6.99)` against `[6.99, 6.99, 6.99]` should
  return 0 (assertion_fail today).
- `indexOf/15.4.4.14-5-16.js` — oob (off-by-one in `i32` index against `len-1`).

Spec gaps in `compileArrayIndexOf` / `compileArrayLastIndexOf` / `compileArrayIncludes`
(`src/codegen/array-methods.ts`):

1. **Strict equality** for `indexOf`/`lastIndexOf` (§23.1.3.16, §23.1.3.20) but
   **SameValueZero** for `includes` (§23.1.3.13). Today we may use `f64.eq` for both,
   which makes `[NaN].includes(NaN)` return `false` (it should return `true`).
2. **Mixed-type elements** — `[1, "1"].indexOf(1)` should return 0 (strict equality;
   1 !== "1"), and `[1, "1"].indexOf("1")` should return 1. With element type unified
   to `externref`, both `f64` and string compare equal under `f64.eq` (oh wait, neither
   is f64) — but the unboxing path may compare the boxed-number to "1" via host
   `Object.is` and fail.
3. **fromIndex coercion** — `arr.indexOf(x, fromIdx)`: spec calls `ToIntegerOrInfinity`.
   - `undefined` → 0 for indexOf, `len-1` for lastIndexOf.
   - `+Infinity` → `len` (search nothing, return -1).
   - `-Infinity` → 0 for indexOf, -1 for lastIndexOf.
   - `NaN` → 0.
   - Symbol → TypeError (we coerce silently to NaN).
4. **Sparse / array-like .call** — same `HasProperty` gating as #1358; for indexOf,
   missing index → just skip; for includes, missing index DOES count when the search
   is `undefined` (because spec uses `Get` which returns `undefined` for missing keys
   on array-like — verify).
5. **OOB**: existing loops use `i32.lt_s` against the length local; off-by-one can
   trap when `len > 2^31` (test262 forces 2^32-2 length on array-like). Use
   `i64.lt_u` for length-vs-index in array-like path, or clamp to `i32.MAX_SAFE_INTEGER` (= 2^53-1).

## Acceptance criteria

1. `built-ins/Array/prototype/indexOf/15.4.4.14-2-7.js` passes.
2. `built-ins/Array/prototype/indexOf/15.4.4.14-9-a-10.js` passes (typed receivers).
3. `built-ins/Array/prototype/indexOf/15.4.4.14-9-c-i-1.js` passes (NaN never equals NaN).
4. `built-ins/Array/prototype/includes/get-prop.js` passes (NaN match in includes).
5. `built-ins/Array/prototype/lastIndexOf/length-near-integer-limit.js` passes.
6. Pass-rate for the three methods rises from ~30% to ≥80%; **+130 net passes**.

## Files to modify

- `src/codegen/array-methods.ts`:
  - `compileArrayIndexOf` and `compileArrayLastIndexOf` — emit f64.eq with NaN guard.
  - `compileArrayIncludes` — emit SameValueZero (NaN-aware).
  - `compileArrayLikePrototypeCall` — extend to indexOf/lastIndexOf/includes (currently
    missing from `ARRAY_LIKE_METHOD_SET` at line 321).

## Implementation Plan

### Root cause

Array search methods were implemented for the typed-element fast path (homogeneous
f64 / i32 / externref arrays) and use a single `eq` op. They:

- Don't distinguish strict-equality (indexOf) from SameValueZero (includes).
- Don't accept array-like receivers (the set at line 321 omits search methods).
- Treat `fromIndex` as `i32.trunc_sat_f64_s`, which silently maps Infinity to
  `i32.MAX`/`i32.MIN` (correct in some cases, wrong in others — `+Infinity` should
  cause an immediate `-1` return for indexOf, but we instead clamp and start the
  loop at `len`, returning `-1` accidentally; for lastIndexOf, `+Infinity` should
  *use* `len-1` as start, not `i32.MAX`).

### Approach

#### 1. Extend `ARRAY_LIKE_METHOD_SET` (line 321)

Add `"indexOf"`, `"lastIndexOf"`, `"includes"`. The array-like loop already exists;
it's just gated.

#### 2. SameValueZero for `includes`

```wasm
;; needle: f64 in $needle; elem: f64 in $elem
local.get $needle
local.get $elem
f64.eq                  ;; covers numeric ==, but NaN != NaN
local.get $needle
local.get $needle
f64.ne                  ;; needle is NaN
local.get $elem
local.get $elem
f64.ne                  ;; elem is NaN
i32.and                 ;; both are NaN
i32.or                  ;; eq OR (both NaN)
br_if $found
```

For externref needle: invoke `__same_value_zero(needle, elem) -> i32` host import.

#### 3. fromIndex semantics

```ts
function emitFromIndex(fctx, lenLocal, isLast: boolean) {
  // ToIntegerOrInfinity
  // if NaN -> 0 / 0
  // if +Inf -> for indexOf: emit `return -1`; for lastIndexOf: clamp to len-1
  // if -Inf -> for indexOf: 0; for lastIndexOf: emit `return -1`
  // negative -> max(len + n, 0)
}
```

Implement via inline f64 checks before the integer truncation.

#### 4. Strict equality for indexOf — typed paths only

For typed Wasm vecs, all elements have the same statically-known type; if the needle
type matches, use the typed `eq` op; if not, the result is always `-1` (different types
under strict equality). This is a constant-fold opportunity: when the static type of
the needle is incompatible with `elemType`, emit `i32.const -1` and skip the loop.

For mixed-element typed vecs (already boxed as externref), invoke
`__strict_equals(a, b) -> i32` host import.

### Edge cases

- `arr.indexOf(undefined)` on a typed `i32[]` — always `-1` (no undefined possible).
- `arr.includes(NaN)` on `f64[]` containing NaN — return `true`.
- `[].indexOf(x)` — `len = 0`, return `-1` immediately.
- `arr.lastIndexOf(x, -1)` — start = len-1; spec says `len + n = len - 1`.
- Symbol needle on number array — treated by `compileExpression` as f64 (NaN); spec
  wants TypeError. Bail out at compile time when needle's static type is `symbol` and
  emit the throw.

### Test262 sample

- `test262/test/built-ins/Array/prototype/indexOf/15.4.4.14-2-7.js`
- `test262/test/built-ins/Array/prototype/indexOf/15.4.4.14-9-a-10.js`
- `test262/test/built-ins/Array/prototype/indexOf/15.4.4.14-9-c-i-1.js` (NaN)
- `test262/test/built-ins/Array/prototype/lastIndexOf/length-near-integer-limit.js`
- `test262/test/built-ins/Array/prototype/includes/get-prop.js`

### Estimated impact

+130–150 net passes. §23.1 jumps another ~5 percentage points.
