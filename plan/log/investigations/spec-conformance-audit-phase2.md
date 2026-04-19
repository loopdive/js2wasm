# Phase 2: §7.2 Testing and Comparison Operations — Spec Conformance Audit

**Date**: 2026-04-17
**Auditor**: dev-A (automated)
**Parent issue**: #1093
**Scope**: §7.2.14 (Abstract Relational Comparison), §7.2.15 (Abstract Equality),
§7.2.16 (Strict Equality Comparison), §7.2.10 (SameValue), §7.2.11 (SameValueZero)

## Files audited

- `src/codegen/binary-ops.ts` — main comparison dispatch (1815 lines)
- `src/codegen/any-helpers.ts` — AnyValue boxing/unboxing + `__any_eq`, `__any_strict_eq`, `__any_lt/gt/le/ge`
- `src/codegen/string-ops.ts` — `compileStringBinaryOp` (string comparison paths)
- `src/codegen/object-ops.ts` — `DefineProperty` SameValue check (§7.2.10)

---

## §7.2.16 Strict Equality Comparison (`===` / `!==`)

**Spec algorithm** (7 steps):
1. If Type(x) ≠ Type(y), return false
2. If x is a Number, return Number::equal(x, y)
3. Return SameValueNonNumber(x, y)

Number::equal: NaN → false; +0/-0 → true; else IEEE compare.

### Our implementation

| Path | Code location | Verdict |
|------|---------------|---------|
| Both f64 (known numeric) | `compileNumericBinaryOp` line 1455: `f64.eq` | ✅ Matches spec — NaN≠NaN, +0===-0 |
| Both i32 (fast mode / native) | `compileI32BinaryOp` line 1517: `i32.eq` | ✅ Correct — i32 has no NaN/±0 |
| Both booleans | `compileBooleanBinaryOp` line 1791: `i32.eq` | ✅ Correct |
| Both strings (externref) | lines 1089-1135: `wasm:js-string equals` | ✅ Content comparison |
| Both strings (native) | `compileStringBinaryOp` line 783-794: `__str_equals` | ✅ Content comparison |
| Both struct refs | line 944: `ref.eq` | ✅ Reference identity |
| Ref vs primitive | line 950-954: always false | ✅ Step 1 |
| Both externref (unknown) | lines 1146-1261: ref.eq → __host_eq → __unbox_number fallback | ✅ Multi-tier |
| Null comparison shortcut | lines 258-263: strict null===null, undef===undef → true; null===undef → false | ✅ Step 1 |
| BigInt vs Number | line 723-732: always false | ✅ Step 1 |
| **AnyValue: both f64 (tag 3)** | `__any_strict_eq` line 888-893: `f64.eq` | ✅ Correct |
| **AnyValue: both string (tag 5)** | `__any_strict_eq` line 925-931: falls through to `tag < 2` → false | ❌ **DEVIATION** |

### Deviation: `__any_strict_eq` string comparison (#1133)

When both AnyValue operands have tag 5 (string), the helper falls through to the
`tag < 2` catch-all, which returns `false` because 5 ≥ 2. Two AnyValue-boxed strings
with identical content but different box identities will incorrectly return `false` for
`===`. Per spec step 3, SameValueNonNumber for strings checks code-unit sequence equality.

**Impact**: Any `===` comparison between `any`-typed string variables that aren't the
exact same AnyValue box reference. E.g.:
```js
let a: any = "hello";
let b: any = "hello";
a === b  // returns false, should return true
```

**Fix**: In `__any_strict_eq`, add a tag-5 branch that calls `wasm:js-string equals`
(or `__str_equals` for native strings) on the `externval` fields.

---

## §7.2.15 Abstract Equality Comparison (`==` / `!=`)

**Spec algorithm** (14 steps):
1. If Type(x) = Type(y), return StrictEqualityComparison(x, y)
2. null == undefined → true
3. undefined == null → true
4. Number == String → Number == ToNumber(String)
5. String == Number → ToNumber(String) == Number
6. BigInt == String → BigInt == StringToBigInt(String)
7. String == BigInt → ditto
8. Boolean == y → ToNumber(Boolean) == y (recurse)
9. x == Boolean → x == ToNumber(Boolean) (recurse)
10. String/Number/BigInt/Symbol == Object → x == ToPrimitive(Object)
11. Object == String/Number/BigInt/Symbol → ToPrimitive(Object) == y
12-14. BigInt ↔ Number comparisons

### Our implementation

| Spec step | Code location | Verdict |
|-----------|---------------|---------|
| Step 1 (same type) | Handled implicitly via TS type narrowing + dispatch | ✅ |
| Steps 2-3 (null/undefined) | lines 256-267: null == undefined → 1 | ✅ |
| Steps 4-5 (string ↔ number) | lines 631-648: parseFloat coercion | ✅ |
| Steps 6-7 (string ↔ bigint) | lines 748-806: both → f64 via parseFloat | ⚠️ Approximate — uses f64 not StringToBigInt |
| Steps 8-9 (boolean coercion) | lines 616-668: bool → f64.convert_i32_s | ✅ |
| Steps 10-11 (object ↔ primitive) | lines 957-991: struct ref → valueOf coercion | ✅ For known struct refs |
| Steps 10-11 for AnyValue objects | `__any_eq`: different tags → cross-tag check only for i32+f64 (tags 2+3) | ❌ **DEVIATION** |
| Steps 12-14 (bigint ↔ number) | lines 748-806: i64 → f64 then compare | ⚠️ Lossy for large BigInts |

### Deviation: `__any_eq` missing object-to-primitive coercion (#1134)

The `__any_eq` helper handles cross-tag comparison ONLY for the i32(2)+f64(3) numeric
case (tag sum = 5). For all other cross-tag pairs, it returns 0. This means:

- `any`-typed object `==` `any`-typed number → false (should call ToPrimitive on object)
- `any`-typed boolean `==` `any`-typed number → false (should coerce boolean to number)
- `any`-typed null `==` `any`-typed undefined → false (should return true per steps 2-3)

The null/undefined case (tags 0+1, sum=1) is particularly impactful since `null == undefined`
is one of the most common loose equality patterns.

**Impact**: Any `==` between `any`-typed values of different types will incorrectly
return false unless both are numeric (i32 or f64).

**Fix**: Add cross-tag cases to `__any_eq`:
- tags 0+1 (null/undefined): return true
- tags 2+4 or 3+4 (number+boolean): coerce bool to number, compare
- tag 6 vs primitive: call ToPrimitive (requires host import)

### Note: BigInt ↔ String loose equality (steps 6-7)

Our implementation converts both to f64 via parseFloat and i64→f64. This is approximate:
large BigInts lose precision in f64, and the spec uses StringToBigInt, not parseFloat.
However, this is a known limitation and low priority since BigInt operations through
`any`-typed dispatch is rare.

---

## §7.2.14 Abstract Relational Comparison (`<`, `<=`, `>`, `>=`)

**Spec algorithm** (summary):
1. Call ToPrimitive(x, "number") and ToPrimitive(y, "number")
2. If both are Strings → lexicographic code-unit comparison
3. If either is a BigInt → BigInt/Number cross-comparison rules
4. Else → ToNumber on both, IEEE 754 comparison (undefined → NaN → false)

### Our implementation

| Path | Code location | Verdict |
|------|---------------|---------|
| Both f64 | `compileNumericBinaryOp` lines 1467-1478: f64.lt/le/gt/ge | ✅ |
| Both i32 | `compileI32BinaryOp` lines 1525-1536: i32.lt_s/le_s/gt_s/ge_s | ✅ |
| Both strings (externref) | `compileStringBinaryOp` via wasm:js-string compare | ✅ Lexicographic |
| Both strings (native) | `compileStringBinaryOp` lines 811-833: `__str_compare` → i32 cmp | ✅ |
| Struct ref operands | lines 957-991: coerceType to f64 via valueOf | ✅ ToPrimitive("number") |
| Externref operands | lines 1072-1086: __unbox_number to f64 | ✅ ToNumber path |
| BigInt ↔ Number | lines 748-806: both → f64 then compare | ⚠️ Lossy for large BigInts |
| AnyValue comparison | `__any_lt/gt/le/ge`: __any_to_f64 both → f64 compare | ⚠️ Missing string path |
| Mixed types (TS-known) | lines 866-912: numeric hint with type promotion | ✅ |

### Deviation: `__any_lt/gt/le/ge` skip string comparison

The comparison helpers (`__any_lt`, `__any_gt`, `__any_le`, `__any_ge`) unconditionally
convert both operands to f64 via `__any_to_f64` and do IEEE comparison. Per spec step 2,
if both ToPrimitive results are strings, comparison should be lexicographic, not numeric.

Example: `"banana" < "cherry"` where both are `any`-typed → `__any_to_f64` produces NaN
for non-numeric strings → `f64.lt(NaN, NaN)` → false. Correct answer: true (lexicographic).

**Impact**: Comparison between `any`-typed string values. The TS-typed string path
(via `compileStringBinaryOp`) is correct; this only affects the AnyValue dispatch path.

This is part of the broader pattern where AnyValue dispatch lacks string awareness —
same root cause as `__any_add` not doing string concatenation.

---

## §7.2.10 SameValue

Already audited in Phase 1 and filed as **#1127**: DefineProperty uses `f64.ne` which
incorrectly returns true for SameValue(NaN, NaN) and true for SameValue(+0, -0).
SameValue requires NaN === NaN (true) and +0 !== -0 (false).

**Status**: #1127 filed, #1132 filed for -0 literal preservation.

## §7.2.11 SameValueZero

Audited in Phase 1. Array.includes correctly implements SameValueZero via
`(elem == val) | (isNaN(elem) & isNaN(val))` pattern. ✅

---

## Summary of deviations found

| # | Spec section | Deviation | Severity | New issue |
|---|-------------|-----------|----------|-----------|
| 1 | §7.2.16 | `__any_strict_eq` tag-5 strings: identity compare, not content | Medium | #1133 |
| 2 | §7.2.15 | `__any_eq` cross-tag: missing null==undefined, bool==number, object==primitive | Medium | #1134 |
| 3 | §7.2.14 | `__any_lt/gt/le/ge`: no string lexicographic path, always numeric | Low | (same root cause as __any_add string gap) |
| 4 | §7.2.10 | SameValue f64 comparison wrong for NaN/±0 | Medium | #1127 (existing) |

### What's correct

The **typed** comparison paths (when TS types are known at compile time) are largely
spec-correct:
- Strict equality handles all type combinations correctly
- Loose equality correctly coerces number↔boolean, string↔number, string↔boolean
- Null/undefined comparisons follow spec for both strict and loose
- String comparison uses proper content equality and lexicographic ordering
- Struct ref strict equality uses reference identity (correct)
- BigInt cross-type comparison works (with precision loss for large values)

The deviations are concentrated in the **AnyValue dispatch path** (`__any_eq`,
`__any_strict_eq`, `__any_lt/gt/le/ge`), which is the runtime fallback when operand
types are `any`. This path lacks string awareness and cross-type coercion logic.
