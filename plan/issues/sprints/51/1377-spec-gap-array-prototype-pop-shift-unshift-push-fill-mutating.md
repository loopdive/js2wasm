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

## Slice B investigation (senior-dev, 2026-05-08)

**Slice A landed** (PR #289 +29 net). Investigated remaining gaps for
Slice B. Findings:

### "Length-NaN coercion" gap is the array-like bridge (#1358)

The probe `obj.length=NaN; obj.push = Array.prototype.push; obj.push(-1)`
shows that AFTER push, `obj.length` reads back as `null` (instead of 1).
Even the BASELINE case `obj.length=2; obj.push(99)` shows length=2 after
push (should be 3).

Root cause: our wasm-side proxy doesn't reflect mutations from native
Array.prototype methods. This is the array-like dispatch bridge —
**already in_progress under #1358** for another dev. Duplicating that
work would conflict; deferring Slice B's length-coercion sub-slice
to land alongside #1358.

### Symbol-as-arg → TypeError (overlaps #1343)

`compileArrayFill` at line 5390-5407 (and similar in `copyWithin`)
unconditionally coerces `start`/`end` args to `f64` via `__unbox_number`,
which silently returns NaN for Symbol args. Per spec ToIntegerOrInfinity
must throw TypeError on Symbol.

Fix would emit a runtime Symbol check before the coercion. But this
overlaps significantly with **#1343 (Boolean wrapper + Symbol
coercion TypeErrors)** which is already in_progress. To avoid
duplicating Symbol-coercion infrastructure, deferring this until the
runtime helpers from #1343 land.

### Achievable Slice B today: limited

Direct probes show the remaining gaps either:
- Need #1358's array-like dispatch fix (length-NaN cases).
- Need #1343's Symbol coercion infrastructure (Symbol → TypeError).
- Need new constructor handling (`new Array().unshift` length=0 bug).
- Need MaxSafeInteger i64 length math (push at 2^53-1 → RangeError).

Each is a non-trivial standalone issue. Slice A's +29 net is what's
reachable without deeper infrastructure work. **Recommend pausing
Slice B** until #1358 / #1343 land, then re-scope.

Senior-dev returning task to queue. Architect re-spec recommended.
