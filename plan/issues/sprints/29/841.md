---
id: 841
title: "Unsupported Math methods: sumPrecise, cosh, sinh, tanh, f16round (19 CE)"
status: done
created: 2026-03-28
updated: 2026-04-14
completed: 2026-04-14
priority: low
feasibility: easy
goal: iterator-protocol
test262_ce: 19
---
# #841 -- Unsupported Math methods (19 CE)

## Problem

19 tests fail because certain Math methods are not implemented. Additionally, 9 tests fail with "Unsupported Math method" for Array methods called on the Math object (false positive -- the compiler misidentifies `Array.prototype.every.call(Math, ...)` as `Math.every`).

## Breakdown

| Method | CE count | Notes |
|--------|----------|-------|
| Math.sumPrecise | 6 files (49 error mentions) | ES2025 proposal, requires iterable support |
| Math.cosh | 1 | Hyperbolic cosine -- `(e^x + e^-x) / 2` |
| Math.sinh | 1 | Hyperbolic sine -- `(e^x - e^-x) / 2` |
| Math.tanh | 1 | Hyperbolic tangent -- `sinh(x)/cosh(x)` |
| Math.f16round | 1 | Float16 rounding -- ES2025 proposal |
| False positives (Array-on-Math) | 9 | `Array.prototype.*.call(Math, ...)` misidentified |

## Sample files with exact errors

### 1. Math.sumPrecise

**File**: `test/built-ins/Math/sumPrecise/sum-is-NaN.js`
**Error**: `L9:18 Unsupported Math method: sumPrecise`
**Source** (lines 10-12):
```js
assert.sameValue(Math.sumPrecise([NaN]), NaN);
assert.sameValue(Math.sumPrecise([Infinity, -Infinity]), NaN);
assert.sameValue(Math.sumPrecise([-Infinity, Infinity]), NaN);
```

### 2. Math.cosh

**File**: `test/built-ins/Math/cosh/cosh-specialVals.js`
**Error**: `L9:18 Unsupported Math method: cosh; L10:18 Unsupported Math method: cosh; L11:18 Unsupported Math method: cosh; L12:18 Unsupported Math method: cosh; L13:18 Unsupported Math method: cosh`
**Source** (lines 9-13):
```js
assert.sameValue(Math.cosh(NaN), Number.NaN, "...");
assert.sameValue(Math.cosh(0), 1, "...");
assert.sameValue(Math.cosh(-0), 1, "...");
assert.sameValue(Math.cosh(Number.NEGATIVE_INFINITY), Number.POSITIVE_INFINITY, "...");
assert.sameValue(Math.cosh(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY, "...");
```

### 3. False positive: Array.prototype.every.call(Math, ...)

**File**: `test/built-ins/Array/prototype/every/15.4.4.16-1-10.js`
**Error**: `L16:18 Unsupported Math method: every`
**Source** (lines 10-16):
```js
function callbackfn(val, idx, obj) {
  return ('[object Math]' !== Object.prototype.toString.call(obj));
}

Math.length = 1;
Math[0] = 1;
assert.sameValue(Array.prototype.every.call(Math, callbackfn), false, '...');
```
The compiler sees `Math` as the receiver and `every` as a Math method, but it's actually `Array.prototype.every` called with `Math` as `this`.

## Root cause

In `src/codegen/expressions.ts`, the Math method lookup table does not include `cosh`, `sinh`, `tanh`, `sumPrecise`, or `f16round`. The false positive for Array-on-Math occurs because the compiler resolves the method name against the receiver type (`Math`) instead of recognizing `.call()` patterns.

## Suggested fix

1. Add `Math.cosh`, `Math.sinh`, `Math.tanh` as `f64 -> f64` using Wasm `f64` arithmetic:
   - `cosh(x) = (exp(x) + exp(-x)) / 2`
   - `sinh(x) = (exp(x) - exp(-x)) / 2`
   - `tanh(x) = sinh(x) / cosh(x)` or `1 - 2/(exp(2x)+1)`
2. Add `Math.f16round` (requires float16 conversion logic)
3. For `Math.sumPrecise`, either skip (ES2025 proposal) or implement via iterable reduction
4. Fix false positive: recognize `Array.prototype.X.call(Math, ...)` pattern

## Acceptance criteria

- Math.cosh, Math.sinh, Math.tanh implemented
- 10+ compile errors eliminated
- False positive for Array-on-Math fixed (9 CE)
