---
id: 228
title: "Issue #228: BigInt equality/strict-equality with Number and Boolean"
status: done
created: 2026-03-11
updated: 2026-04-14
completed: 2026-03-13
priority: medium
goal: builtin-methods
files:
  src/codegen/expressions.ts:
    new: []
    breaking:
      - "compileBinaryExpression: add i64/f64 strict equality short-circuit (always false for ===, true for !==)"
      - "compileBinaryExpression: add i64-to-f64 conversion for loose equality with mixed BigInt/Number types"
---
# Issue #228: BigInt equality/strict-equality with Number and Boolean

## Status: done

## Summary

7 BigInt-related tests fail: `bigint-and-number.js` in equals/does-not-equals/strict-equals/strict-does-not-equals, and `bigint-and-boolean.js` in strict-equals/strict-does-not-equals. These test loose and strict equality between BigInt and other types.

## Root Cause

The equality codegen does not handle mixed BigInt (i64) + Number (f64) comparisons. For loose equality (`==`), `0n == 0` should be true (BigInt and Number are compared by mathematical value). For strict equality (`===`), `0n === 0` should be false (different types). The codegen likely either traps or returns wrong results.

## Scope

- `src/codegen/expressions.ts` -- equality/strict-equality operator codegen
- Tests affected: 7 BigInt equality tests

## Expected Impact

Fixes 7 runtime failures.

## Suggested Approach

1. For strict equality (`===`, `!==`): BigInt and Number are different types, so always return false/true respectively. Emit `i32.const 0` (for ===) or `i32.const 1` (for !==) when operand types are i64 vs f64.
2. For loose equality (`==`, `!=`): Convert i64 to f64 via `f64.convert_i64_s` and compare with `f64.eq`. This handles the "same mathematical value" requirement.
3. For BigInt vs Boolean: In loose equality, convert boolean to number first (true=1, false=0), then compare with converted BigInt.

## Acceptance Criteria

- [x] `0n === 0` returns false (strict, different types)
- [x] `0n == 0` returns true (loose, same value)
- [x] All 7 BigInt equality tests pass

## Implementation Notes

Modified `compileBinaryExpression` in `src/codegen/expressions.ts`:
- Strict equality (`===`/`!==`): BigInt vs Number always returns false/true (different types). Emits `i32.const 0`/`i32.const 1` after dropping both operands.
- Loose equality (`==`/`!=`): Converts i64 to f64 via `f64.convert_i64_s`, then uses `f64.eq`/`f64.ne`.
- Also handles the compiled-type fallback path (when types are detected as i64/f64 at compile time rather than via TS type flags).

Added 2 equivalence tests in `tests/equivalence/bigint.test.ts`: BigInt loose equality, BigInt strict equality returning false.

## Implementation Summary

The codegen in `compileBinaryExpression` already handles mixed BigInt/Number and BigInt/Boolean equality via two paths:

1. **TS type-aware path** (line ~2570): When `isBigIntType()` detects BigInt on one side, strict equality emits constant `i32.const 0`/`i32.const 1` (different types), and loose equality converts both operands to f64 then uses `f64.eq`/`f64.ne`. Boolean (i32) operands are handled via `f64.convert_i32_s`.

2. **Compiled-type fallback path** (line ~2754): When compiled types are i64 vs f64 (e.g., from variables), same logic applies: strict equality short-circuits, loose equality converts i64 to f64 with stack swap if needed.

Added `tests/issue-228.test.ts` with 4 test cases covering BigInt vs Number and BigInt vs Boolean for both loose and strict equality. All pass.

### Files changed
- `tests/issue-228.test.ts` (new) -- 4 test cases for BigInt equality
- `plan/issues/sprints/0/228.md` (moved from ready/)

## Complexity: S
