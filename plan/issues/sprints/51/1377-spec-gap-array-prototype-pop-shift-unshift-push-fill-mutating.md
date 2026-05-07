---
id: 1377
sprint: 51
title: "spec gap: Array.prototype.{push,pop,shift,unshift,fill,copyWithin,reverse} — mutation on array-like + length writes (~80 fails)"
status: ready
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
