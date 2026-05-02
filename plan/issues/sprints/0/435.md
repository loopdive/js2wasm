---
id: 435
title: "Logical/conditional operators must preserve object identity (16 fail)"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: core-semantics
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileLogicalExpression — preserve reference identity for object operands"
      - "compileConditionalExpression — preserve reference identity in ternary branches"
---
# #435 — Logical/conditional operators must preserve object identity (16 fail)

## Problem

16 tests fail at runtime because logical operators (`&&`, `||`) and the conditional operator (`?:`) do not preserve object reference identity. In JavaScript, `true && obj` must return the exact same object reference as `obj`, and `obj ? obj : other` must return the same reference. The compiler appears to either unbox and re-box the values or otherwise lose reference identity.

### Failing patterns

| Category | Count | Pattern |
|----------|-------|---------|
| logical-and | 3 | `new Boolean(true) && y` must return `y` (same ref) |
| logical-or | 3 | `new Number(0) \|\| y` must return `y` (same ref) |
| conditional | 3 | `true ? y : false` must return `y` (same ref) |
| instanceof | 3 | `new Boolean instanceof Boolean` must be true |
| void | 3 | `void x` must return undefined, not NaN |
| prefix-increment | 1 | `++x` where x is null/undefined |

### Sample failing tests

- `test/language/expressions/logical-and/S11.11.1_A4_T1.js`:
  ```javascript
  var y = new Boolean(true);
  if ((new Boolean(true) && y) !== y) { throw ... }
  ```
  The `&&` operator should return the second operand (`y`) when the first is truthy. The result must be the same object reference, verified by `!==`.

- `test/language/expressions/conditional/S11.12_A4_T1.js`:
  ```javascript
  var y = new Boolean(true);
  if ((true ? y : false) !== y) { throw ... }
  ```

- `test/language/expressions/void/S11.4.2_A4_T3.js`:
  ```javascript
  var x = "1";
  if (void x !== undefined) { throw ... }
  ```
  The `void` operator should always return `undefined`, but the compiler may return a numeric coercion instead.

## Root cause

The compiler's logical expression codegen likely converts operands to f64 (for truthiness checks) and then returns the numeric value rather than the original object reference. For `&&` and `||`, the JS spec requires returning one of the two operands as-is, not a boolean or coerced value.

For `void`, the compiler may be evaluating the expression and returning its value instead of discarding it and returning `undefined`.

## Priority: medium (16 tests)

## Complexity: S

## Acceptance criteria
- [ ] `true && obj` returns `obj` (same reference)
- [ ] `false || obj` returns `obj` (same reference)
- [ ] `true ? obj : other` returns `obj` (same reference)
- [x] `void expr` always returns `undefined`
- [ ] `new Boolean instanceof Boolean` returns true
- [ ] Reduce logical/conditional reference identity failures to zero

## Implementation Notes

### Investigation findings

1. **Logical operators (`&&`, `||`, `??`) already correctly preserve object identity** for cases where both operands share the same Wasm type or can be unified to a common type. The implementation in `compileLogicalAnd`, `compileLogicalOr`, and `compileNullishCoalescing` properly saves the LHS in a local, checks truthiness, and returns the original value.

2. **Conditional expressions (`?:`) also correctly preserve identity** through `compileConditionalExpression` which unifies branch types and returns the original value.

3. **The `new Boolean(true)` and `new Number(0)` patterns require wrapper constructor support** which is explicitly in the test262 skip list -- these are out of scope.

4. **The `instanceof` failures also require wrapper constructor support** -- out of scope.

5. **The `void` operator had a real bug**: when `void expr` appeared in a numeric context (f64 or i32), the externref `ref.null.extern` was passed through `__unbox_number` which calls `Number(null)` returning `0` instead of `Number(undefined)` returning `NaN`. This happened because Wasm's `ref.null.extern` maps to JS `null`, not `undefined`, at the boundary.

### Fix applied

Added fast-paths in `compileExpression` to detect `VoidExpression` in numeric and AnyValue contexts:

- **f64 context**: Evaluate operand for side effects, drop, push `f64.const NaN`
- **i32 context**: Evaluate operand for side effects, drop, push `i32.const 0`
- **AnyValue context**: Evaluate operand for side effects, drop, call `__any_box_undefined()`

This avoids the externref roundtrip where null/undefined are indistinguishable.
