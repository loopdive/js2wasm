---
id: 1380
sprint: 51
title: "spec gap: equality (==, !=, ===, !==) — Symbol/BigInt coercion + ReferenceError propagation (~55 fails)"
status: in-progress
created: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: operators
goal: spec-completeness
---
# #1380 — Equality operators: Symbol/BigInt + ReferenceError short-circuit

## Problem

`language/expressions/{equals,does-not-equals,strict-equals,strict-does-not-equals}` —
**55 fails**: 37 'other', 13 assertion_fail, 4 type_error, 1 runtime_error.

Failing patterns:

- `equals/S11.9.1_A2.1_T3.js` — "1 == y throw ReferenceError. Actual: null"
  (the right side of `==` is an unresolved reference; spec says ReferenceError
  must propagate; we return null/undefined silently).
- `equals/coerce-symbol-to-prim-return-prim.js` — runtime_error
  "Cannot convert a Symbol value to a number" (spec actually says throw TypeError).
- `does-not-equals/bigint-and-object.js` — `0n != Object(0n)` should be false.
- `strict-equals/S11.9.4_A8_T4.js` — "null !== new Object()" — should be true; we
  apparently get false ("other" error category).

Spec §7.2.13 (IsLooselyEqual):

1. Same type → strict equality.
2. null == undefined.
3. Number vs string → ToNumber the string.
4. Boolean vs anything → ToNumber the boolean.
5. Number/string vs object → ToPrimitive the object.
6. **BigInt vs Number / string** → numeric compare (spec carefully handles
   precision).
7. **Symbol** → never == anything except itself.

Current implementation in `src/codegen/binary-ops.ts` likely:

- Doesn't check `Type(x) === Symbol → coerce error`.
- Doesn't run `ToPrimitive` on object operands consistently.
- Subexpression evaluation order: spec evaluates LEFT first, THEN right. If LEFT
  is unresolved reference → ReferenceError immediately. We may evaluate right
  first or both lazily.

## Acceptance criteria

1. `language/expressions/equals/S11.9.1_A2.1_T3.js` passes (ReferenceError on right).
2. `language/expressions/equals/coerce-symbol-to-prim-return-prim.js` passes
   (TypeError on Symbol coercion).
3. `language/expressions/does-not-equals/bigint-and-object.js` passes.
4. `language/expressions/strict-equals/S11.9.4_A8_T4.js` passes.
5. Pass-rate for the four equality ops rises from ~62% to ≥90%; **+40 net passes**.

## Files to modify

- `src/codegen/binary-ops.ts` — equality compilation paths.
- `src/runtime.ts` — `__abstract_equality(a, b) -> i32` helper for hard cases.

## Implementation Plan

### Root cause

Equality codegen is fragmented into typed-fast-paths plus a fallback that goes
through host imports. The fallback handles most cases correctly; the typed paths
miss spec edge cases (e.g. `f64 == externref` doesn't run ToPrimitive on the
externref).

### Approach

#### A. Type-table for ==

Build the §7.2.13 dispatch as a 2D switch on `(typeof left, typeof right)`:

| left \ right | Number       | String      | Boolean        | Object        | Symbol      | BigInt        | null/undef |
|--------------|--------------|-------------|----------------|---------------|-------------|---------------|------------|
| Number       | f64.eq       | str→num     | bool→num       | ToPrim, retry | false       | bigint compare| false      |
| String       | str→num      | strEq       | str→num,bool→num| ToPrim, retry| false       | numeric str   | false      |
| Boolean      | bool→num     | bool,str→num| bool eq        | ToPrim, retry | false       | bool→num     | false      |
| Object       | ToPrim, retry| ToPrim, retry| ToPrim, retry  | refEq         | false       | ToPrim, retry| false      |
| Symbol       | false        | false       | false          | false         | symbolEq    | false        | false      |
| BigInt       | numeric cmp  | numeric str | bool→num       | ToPrim, retry | false       | bigintEq     | false      |
| null/undef   | false        | false       | false          | false         | false       | false        | true       |

For typed fast paths, statically resolve to the cell. For union or externref
operands, dispatch via host import `__abstract_equality`.

#### B. Symbol coercion error

When user writes `5 == Symbol("x")`:
- Static type check at compile: if right is Symbol, spec says LooseEquals returns
  false UNLESS left is also Symbol (then SameValue).
- BUT `Symbol("x") + 1` (note: `+`, not `==`) throws TypeError; for `==`, no throw.

The failing test is `coerce-symbol-to-prim-return-prim.js` — read it; likely
the LHS is an object whose `valueOf` returns a Symbol; the spec's ToPrimitive
preference path then has to coerce the Symbol to a number, which throws TypeError.
Today we throw a generic runtime_error with the wrong message.

Fix: in `__abstract_equality` host helper:
```js
__abstract_equality(a, b) {
  // ... full spec; ToPrimitive may throw on Symbol; that throw is intentional.
}
```

#### C. BigInt vs Object

`0n != Object(0n)` — spec:

1. Object(0n).[[Prototype]] is `BigInt.prototype`; the boxed value is 0n.
2. `ToPrimitive(Object(0n), "number")` returns `0n` (BigInt, via .valueOf()).
3. Compare `0n` vs `0n` → equal.
4. `!=` of equals → false.

Our impl probably:
- Recognizes object on right; calls `ToPrimitive`.
- ToPrimitive for BigInt-wrapper returns... unboxed value? If we don't have
  BigInt-wrapper support, returns NaN or string.

Fix: ensure `__to_primitive(v, hint)` handles BigInt wrappers correctly
(delegates to `v.valueOf()`).

#### D. Evaluation order — left first

Verify that `compileBinaryExpression` for `===` / `==` evaluates left BEFORE
right. If left throws (e.g. unresolved reference), the throw must propagate
without right being touched.

For `something_undeclared == 1` — accessing `something_undeclared` should throw
ReferenceError. If our codegen lowers `===` as `compileExpression(right);
compileExpression(left); ===`, the right is evaluated first — wrong.

Spec ordering: left first, then right.

### Edge cases

- `NaN === NaN` → false (strict eq via f64.eq).
- `+0 === -0` → true.
- `+0 == -0` → true.
- `null == undefined` → true.
- `null === undefined` → false.
- `1n == 1` → true.
- `1n === 1` → false (different types).
- `Symbol() === Symbol()` → false (different symbols).
- `(s = Symbol()) === s` → true.
- `{} == {}` → false (reference equality).

### Test262 sample

- `test262/test/language/expressions/equals/S11.9.1_A2.1_T3.js`
- `test262/test/language/expressions/equals/coerce-symbol-to-prim-return-prim.js`
- `test262/test/language/expressions/does-not-equals/bigint-and-object.js`
- `test262/test/language/expressions/strict-equals/S11.9.4_A8_T4.js`
- `test262/test/language/expressions/strict-does-not-equals/S11.9.5_A2.1_T2.js`
- `test262/test/language/expressions/strict-does-not-equals/S11.9.5_A8_T2.js`

### Estimated impact

+40 passes. §13.11 climbs from 62% to ~90%.
