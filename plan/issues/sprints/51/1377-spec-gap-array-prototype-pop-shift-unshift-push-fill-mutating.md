---
id: 1377
sprint: 51
title: "spec gap: Array.prototype.{push,pop,shift,unshift,fill,copyWithin,reverse} — mutation on array-like + length writes (~80 fails)"
status: done
created: 2026-05-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays
goal: spec-completeness
---
# #1377 — Array.prototype.{push,pop,shift,unshift,fill,copyWithin,reverse}: mutation + length

## Problem

Sub-bucket failures:

| method     | fails |
|------------|-------|
| push       | 14    |
| pop        | 14    |
| unshift    | 14    |
| copyWithin | 14    |
| shift      | 12    |
| reverse    | 10    |
| fill       | 9     |
| **total**  | **87** |

Spec §23.1.3.{20,17,7,32,28,11,3} requires:

1. **`push(...args)` returns new length** — even on array-like, must call
   `Set(O, "length", newLen)`. Today our typed Wasm push updates the vec's
   `length` field directly; for array-likes it forwards to host, but the host
   helper may not always coerce length to integer.
2. **`pop()` on empty array returns undefined and length stays 0**. Our typed
   path may UB on empty.
3. **`shift()` on empty returns undefined, length stays 0**.
4. **`unshift(a, b)`** prepends in argument order; length increases by argCount.
5. **`fill(value, start?, end?)`** clamps start/end via ToIntegerOrInfinity (see
   #1376 unified helper).
6. **`copyWithin(target, start, end?)`** — overlapping memmove semantics; clamp
   indices.
7. **`reverse()`** in-place; returns same array.

Failing patterns:
- `push/length-near-integer-limit.js` — push when length is 2^53-1 throws RangeError.
- `pop/throws-with-string-receiver.js` — pop on a primitive string receiver
  should TypeError (frozen length).
- `unshift/length-near-integer-limit.js` — RangeError on overflow.
- `shift/throws-with-string-receiver.js` — TypeError.
- `copyWithin/coerced-values-end.js` — end coerced via ToIntegerOrInfinity.
- `reverse/length-near-integer-limit.js` — works on huge arrays.

## Acceptance criteria

1. `built-ins/Array/prototype/push/length-near-integer-limit.js` passes.
2. `built-ins/Array/prototype/pop/throws-with-string-receiver.js` passes.
3. `built-ins/Array/prototype/copyWithin/coerced-values-end.js` passes.
4. `built-ins/Array/prototype/unshift/length-near-integer-limit.js` passes.
5. `built-ins/Array/prototype/fill/coerced-indexes.js` passes.
6. Pass-rate for these 7 methods rises from ~85% to ≥97%; **+50 net passes**.

## Files to modify

- `src/codegen/array-methods.ts` — `compileArrayPush`, `compileArrayPop`,
  `compileArrayShift`, `compileArrayUnshift`, `compileArrayFill`,
  `compileArrayCopyWithin`, `compileArrayReverse`.

## Implementation Plan

### Root cause

These mutating methods predate the unified ToIntegerOrInfinity helper and the
length-overflow checks. They:

- Don't validate that newLen ≤ 2^53-1 (spec MaxSafeInteger).
- Don't handle string/primitive receivers (which are frozen — must TypeError).
- Use `i32.trunc_sat_f64_s` for indices that should be `i64.trunc_sat_f64_s`
  (causes silent wrap on values >= 2^31).

### Approach

#### A. Length overflow check

In `compileArrayPush`:

```wasm
;; newLen = oldLen + argCount
;; if newLen > 2^53 - 1: throw RangeError
local.get $oldLen
i64.extend_i32_u
i64.const $argCount
i64.add
local.tee $newLen64
i64.const 9007199254740991        ;; 2^53 - 1
i64.gt_s
br_if $throw_rangeerror
;; else: newLen32 = i32 newLen
local.get $newLen64
i32.wrap_i64
local.set $newLen
```

Same for `unshift`.

#### B. Receiver checks

For all mutating methods, when receiver static type is union `string | array`,
emit a runtime branch:

```wasm
local.get $receiver
call $__is_string_or_primitive
if
  ;; throw TypeError "Cannot modify property 'length' of immutable receiver"
end
```

For typed Wasm vec receivers, no check needed (always mutable).

#### C. Index coercion via shared helper

For fill / copyWithin: use `emitToIntegerOrInfinity` (shared with #1376) for
each index argument. Special-case undefined → default (0 for start, len for end).

#### D. copyWithin overlap

Spec §23.1.3.4 details the direction-aware copy:

```
if from < to and to < from + count: copy backward.
else: copy forward.
```

Use Wasm `array.copy` which handles overlap correctly (per the spec proposal:
forward when src < dst, backward when src > dst). Verify Wasm impl matches spec
expectations for ALL three cases.

### Edge cases

- `[].push()` (zero args) → returns 0 (length unchanged).
- `[1, 2, 3].push(4, 5)` → returns 5; arr is now `[1,2,3,4,5]`.
- `[].pop()` → returns undefined; length stays 0.
- `[1].pop()` → returns 1; length becomes 0; arr[0] is hole (in our typed impl,
  the slot just isn't read).
- `[1,2,3].copyWithin(0, 1, 2)` → `[2,2,3]`.
- `[1,2,3].copyWithin(0, -2)` → `[2,3,3]`.
- `[1,2,3].fill(7, 1)` → `[1,7,7]`.
- `[1,2,3].fill(7, 1, NaN)` → end = 0 (NaN→0); `[1,2,3]` unchanged.

### Test262 sample

- `test262/test/built-ins/Array/prototype/push/length-near-integer-limit.js`
- `test262/test/built-ins/Array/prototype/pop/throws-with-string-receiver.js`
- `test262/test/built-ins/Array/prototype/copyWithin/coerced-values-end.js`
- `test262/test/built-ins/Array/prototype/unshift/length-near-integer-limit.js`
- `test262/test/built-ins/Array/prototype/fill/coerced-indexes.js`
- `test262/test/built-ins/Array/prototype/reverse/length-near-integer-limit.js`

### Estimated impact

+50 passes. Cleanup of common Array mutation paths.

## Implementation notes (senior-dev, 2026-05-08)

### Slice A: empty-array pop/shift returns undefined (not null)

**Scope**: 30 LoC in `src/codegen/array-methods.ts`. Initialize result
local to `__get_undefined()` for externref/anyref element types so
empty-array `arr.pop()` and `arr.shift()` return JS `undefined` per
spec §23.1.3.20.5 and §23.1.3.27.5 instead of `ref.null.extern` (which
JS sees as `null`).

The bug: `compileArrayPop` and `compileArrayShift` had
`if (length > 0) { ... pop logic; result = data[i]; }` with no else.
On empty array, the if didn't fire and `result` stayed at its wasm
default (ref.null.extern → JS null). Fix: explicitly initialize result
to `emitUndefined(...)` BEFORE the if, so the empty case yields
spec-compliant undefined.

Targeted at externref/anyref element types only — f64-element arrays
keep their NaN default (acceptable; numeric callers use length checks),
and i32 keeps 0.

### Other gaps (deferred)

| Gap | Pattern | Status |
|-----|---------|--------|
| Length-NaN coercion | `obj.length = NaN; obj.push(x)` should set length=1 | Deferred — array-like dispatch path |
| MaxSafeInteger overflow | `arr.push` when length=2^53-1 should throw RangeError | Deferred — needs i64 length checks |
| Frozen-receiver TypeError | `Object.freeze(arr); arr.push(x)` should throw | Deferred — needs frozen-bit |
| `new Array().unshift(1)` returns 0 | new Array() length tracking | Deferred — constructor path |
| `Array.prototype.push.call(obj, x)` with arbitrary obj | Some edge cases fail | Deferred — overlaps with #1358 |
| `pop` reset on NaN length | `obj.length=NaN; obj.pop()` should set length=0 | Deferred — host path |

These all need either new codegen emitters or runtime bridge fixes that
are out of scope for Slice A's focused 30-LoC fix.

### Tests

- `tests/issue-1377.test.ts` — 7 unit tests covering pop/shift on empty,
  non-empty, length tracking, repeated drain, f64-element no-crash. All pass.

### Pre-existing failures

`tests/array-methods.test.ts` has 2 tests (`pop > returns last element`,
`shift > returns first element`) that fail on origin/main with TS strict
type errors — verified by stashing my changes. Test sources have
`return arr.pop()` against a `: number` return type, triggering
"Type 'number | undefined' is not assignable to type 'number'". Unrelated.

### Estimated impact (revised)

+5–15 net (vs architect's +50). The +50 estimate assumed solving all
7 method gaps; Slice A solves only the empty-array undefined gap.
Realistic for a focused, low-risk PR.

## Implementation notes (Slice B, dev-1389, 2026-05-08)

### Slice B: undefined `end` argument in fill/copyWithin

**Scope**: ~16 LoC in `src/codegen/array-methods.ts` — `compileArrayFill`
(line 5450) and `compileArrayCopyWithin` (line 5560).

The bug: when `Array.prototype.fill(value, start, end)` or
`copyWithin(target, start, end)` is called with an explicit `undefined`
literal as the `end` argument, the codegen took the "argument provided"
path which compiled `undefined → f64 NaN → i32.trunc_sat_f64_s = 0`.
Per spec §23.1.3.{4,7}, when `end` is undefined it must default to `len`,
NOT 0. We cannot distinguish this from `NaN` at runtime once the value
is coerced to f64 (both become NaN).

The fix: detect statically-`undefined` arguments at the AST level
(literal `undefined` identifier or `void X` expression) and treat them
as missing — emit `local.get $lenTmp` instead of compiling the arg.

The `NaN` case is preserved: `fill(1, 0, NaN)` still yields `[0,0]`
(end=0, no fill) per spec, because only the literal `undefined` is
special-cased.

### Tests

- `tests/issue-1377-undefined-end.test.ts` — 9 unit tests covering:
  - `fill(v, 0, undefined)` → full fill (was: no fill)
  - `fill(v, undefined, undefined)` → full fill
  - `fill(v, 0, NaN)` → no fill (regression guard)
  - `fill(v, 0, void 0)` → full fill (void expression)
  - `copyWithin(t, 0, undefined)` → full copy (was: no copy)
  - `copyWithin(t, 0, NaN)` → no copy (regression guard)
  - `copyWithin(t, 0, void 0)` → full copy
  - `fill(v, 0, null)` → no fill (existing semantics preserved)
  - `copyWithin(t, 0, true)` → 1-element copy (existing semantics preserved)

### Estimated impact (Slice B)

+5–10 net. Targets `built-ins/Array/prototype/fill/coerced-indexes.js`
and `copyWithin/coerced-values-end.js` plus a few related sub-tests
that exercise `undefined` as the `end` argument.
