---
id: 1379
sprint: 51
title: "spec gap: prefix/postfix ++/-- on null/undefined/string operands — ToNumeric coercion (~40 fails)"
status: ready
created: 2026-05-08
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: operators
goal: spec-completeness
---
# #1379 — Prefix/postfix ++/-- on null/undefined/string operands

## Problem

`language/expressions/{prefix,postfix}-{increment,decrement}` — 40 fails total
(10 each). The 'other' bucket dominates with assertion messages like:

- `prefix-increment/S11.4.4_A3_T4.js`: "var x = null; ++x; x === 1. Actual: NaN"
- `postfix-decrement/S11.3.2_A4_T3.js`: "var x = '1'; var y = x--; y === 1. Actual: NaN"

Spec §13.4 (UpdateExpressions):

```
EvaluateExpression
oldValue = ToNumeric(GetValue(lhs))
newValue = oldValue + 1 (or - 1, or BigInt + 1n)
PutValue(lhs, newValue)
```

Where `ToNumeric` is:

1. `prim = ToPrimitive(arg, NUMBER_HINT)`.
2. If `prim` is BigInt → return `prim`.
3. Else return `ToNumber(prim)`.

`ToNumber("1")` is `1`. `ToNumber(null)` is `+0`. `ToNumber(undefined)` is `NaN`.

So `var x = "1"; x--` → `oldValue = ToNumeric("1") = 1`; postfix yields `1`,
new x is `0`. We yield NaN — meaning we don't coerce string to number first.

Similarly `var x = null; ++x; x === 1` → spec gives `oldValue = +0`, new x is `1`.
We give NaN — we don't coerce null to 0.

## Acceptance criteria

1. `language/expressions/postfix-decrement/S11.3.2_A4_T3.js` passes (string → number).
2. `language/expressions/prefix-increment/S11.4.4_A3_T4.js` passes (null → 0).
3. `language/expressions/postfix-increment/S11.3.1_A4_T4.js` passes (null → 0).
4. `language/expressions/prefix-decrement/S11.4.5_A3_T5.js` passes
   (object with valueOf returning string).
5. Pass-rate for these 4 ops rises from ~50% to ≥85%; **+30 net passes**.

## Files to modify

- `src/codegen/expressions.ts` — `compilePrefixUnaryExpression`,
  `compilePostfixUnaryExpression`.
- `src/codegen/type-coercion.ts` — verify `coerceType(externref, f64)` produces
  ToNumber semantics, not "if it's a number, unbox; else NaN".

## Implementation Plan

### Root cause

When the operand of `++` or `--` is statically typed as `externref` or
`null | undefined | string`, the compiler emits a coercion to f64 that is too
narrow:

```ts
// Current (pseudo):
if (operandType is f64) {
  // numeric path: f64.const 1; f64.add
} else {
  // emit __unbox_number(operand) -> f64
  //   __unbox_number returns NaN for non-numbers (incl. "1" and null)
}
```

The `__unbox_number` host import returns NaN for any non-Number boxed value;
it does NOT call ToNumber.

### Approach

#### A. Replace `__unbox_number` with `__to_numeric_f64`

Add `__to_numeric_f64(externref) -> f64` host import that runs the spec's
ToNumeric algorithm:

```ts
__to_numeric_f64(v) {
  if (typeof v === 'bigint') {
    // BigInt path is separate (#1349); for ++/--, coerce to f64 with truncation
    // OR throw if mixed. Spec actually says ++/-- on BigInt yields BigInt.
    // For now, if statically known not BigInt, route to f64.
    return Number(v);
  }
  return Number(v);  // ToNumber covers string, null, undefined, boolean, object via valueOf.
}
```

#### B. BigInt path

If operand is statically known BigInt, emit BigInt-specific increment via host
import (`__bigint_inc(externref) -> externref`). Cross-link with #1349.

If operand type is union BigInt | f64, dispatch at runtime: check via host
`__is_bigint(externref) -> i32`, then route.

#### C. Static-type fast paths

For `var x: number; x++`, the f64 path is correct — no coercion needed.

For `var x: string; x++`, statically the result is `f64`; emit
`__string_to_number(operand_string) -> f64` then `f64.add 1`.

For `var x: any; x++`, full ToNumeric runtime dispatch.

### Edge cases

- `++undefined` is a SyntaxError (LeftHandSideExpression rule); compile-time check.
- `var x = ""; ++x === 1` — empty string → 0 → 1.
- `var x = " 42 "; ++x === 43` — `ToNumber(" 42 ")` is 42 (whitespace trimmed).
- `var x = "abc"; ++x` — NaN; correctly NaN, not 1.
- `var x = {valueOf: () => 5}; ++x` — `5 + 1 = 6` per ToPrimitive→ToNumber.
- `var x = {valueOf: () => "5"}; ++x` — ToPrimitive returns "5"; ToNumber("5") = 5; result 6.
- Reference is a property access (`obj.x++`) — Get + ToNumeric + Set.
- Reference is array index (`arr[i]++`) — same.

### Test262 sample

- `test262/test/language/expressions/postfix-decrement/S11.3.2_A4_T3.js`
- `test262/test/language/expressions/prefix-increment/S11.4.4_A3_T4.js`
- `test262/test/language/expressions/postfix-increment/S11.3.1_A4_T4.js`
- `test262/test/language/expressions/prefix-decrement/S11.4.5_A3_T5.js`

### Estimated impact

+30 passes; secondary lifts in user code that uses string-typed counters.
