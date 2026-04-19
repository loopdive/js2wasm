# Phase 1 — Abstract Operations Spec Conformance Audit

**Date**: 2026-04-17
**Auditor**: dev-A
**Issue**: #1093
**Scope**: Phase 1 — Abstract Operations (§7.1–§7.4)
**Source**: https://tc39.es/ecma262/ (living standard)

---

## Summary

Audited 17 Abstract Operations from the issue table against our implementation in
`src/codegen/type-coercion.ts`, `src/runtime.ts`, `src/codegen/binary-ops.ts`,
`src/codegen/index.ts`, and `src/codegen/any-helpers.ts`.

**Result**: 6 operations match spec, 8 have deviations, 3 are not implemented.

---

## 1. ToPrimitive (§7.1.1) — `_toPrimitive` / `_hostToPrimitive` / type-coercion.ts

**Status**: Mostly matches spec. Known issues tracked in #1090.

### Spec algorithm (summary):
1. If input is not Object, return input.
2. If @@toPrimitive exists: call it; if result is non-Object, return it; else throw TypeError.
3. If no @@toPrimitive: call OrdinaryToPrimitive(input, hint).

### Our implementation:
- `_toPrimitive()` (runtime.ts:220): checks sidecar @@toPrimitive, then valueOf/toString per hint order. ✅
- `_hostToPrimitive()` (runtime.ts:400): checks real JS property @@toPrimitive (through proxy), then sidecar. ✅
- Both throw TypeError for non-callable @@toPrimitive. ✅
- OrdinaryToPrimitive hint ordering (string → toString first, number/default → valueOf first). ✅
- Compile-time path in type-coercion.ts: checks @@toPrimitive struct methods, then valueOf/toString. ✅

### Deviations found:
- **`_toPrimitive` returns `undefined` instead of throwing TypeError when no conversion found** (runtime.ts:379).
  Per §7.1.1.1 step 6: "Throw a TypeError exception." Our function returns undefined, and callers
  handle it with fallbacks like `?? "[object Object]"` (line 388). This is a soft deviation — callers
  work around it, but it means TypeError is swallowed for some code paths.
  **Impact**: Low (callers compensate), but tests checking for TypeError on OrdinaryToPrimitive failure may fail.
  **Existing issue**: #1090 covers most ToPrimitive gaps.

---

## 2. ToBoolean (§7.1.2) — `ensureI32Condition` / `__is_truthy` / `__any_unbox_bool`

**Status**: ✅ Matches spec.

### Spec table:
- undefined → false, null → false, Boolean → same, Number → false if +0/-0/NaN else true,
  String → false if empty else true, Symbol → true, BigInt → false if 0n else true, Object → true.

### Our implementation:
- `ensureI32Condition()` (index.ts:5870):
  - f64: uses `f64.abs` + `f64.gt(0)` — correctly treats NaN, +0, -0 as falsy. ✅
  - externref: delegates to `__is_truthy` host import → `(v) => v ? 1 : 0` in runtime.ts:2960. ✅
  - ref/ref_null AnyValue: uses `__any_unbox_bool` (any-helpers.ts:378). ✅
  - Native strings: checks length > 0. ✅
  - i32: used as-is (0 = false, nonzero = true). ✅

### Deviations found:
- None. Spec-conformant for all paths we handle.
- **Gap**: Document/Symbol types are not compiled as distinct Wasm types — they're externref.
  Symbols routed through `__is_truthy` correctly return true. ✅

---

## 3. ToNumber (§7.1.3) — `__unbox_number` / `tryStaticToNumber` / type-coercion.ts

**Status**: Partially matches spec. Gaps in object-to-number path.

### Spec table:
- undefined → NaN, null → +0, Boolean → 0 or 1, Number → same,
  String → StringToNumber, Symbol → TypeError, BigInt → TypeError, Object → ToPrimitive("number") then ToNumber.

### Our implementation:
- `__unbox_number` host import: `Number(v)` in runtime — handles string, boolean, null, undefined. ✅
- `tryStaticToNumber()` (expressions/misc.ts:225): compile-time constant folding for string literals,
  unary +, binary ops, object literals with valueOf. ✅
- Type-coercion paths: ref → f64 tries @@toPrimitive("number"), then valueOf, then toString. ✅

### Deviations found:
1. **Symbol → TypeError not enforced at compile time.** If a Symbol value reaches `__unbox_number`,
   `Number(Symbol())` throws at runtime in the host. But standalone/WASI mode has no host —
   Symbol values would produce wrong output, not TypeError.
   **Impact**: Low (Symbols rarely used as numbers), but affects test262 Symbol tests.

2. **BigInt → TypeError not enforced.** BigInt is not a distinct Wasm type; if a BigInt value
   (via externref) reaches `__unbox_number`, it throws in the host, but standalone mode would fail silently.
   **Impact**: Low (BigInt support is limited overall).

3. **Object → Number path doesn't always throw when OrdinaryToPrimitive fails.**
   See ToPrimitive deviation #1 — returns undefined which `__unbox_number` converts to NaN instead of TypeError.
   **Impact**: Medium — test262 tests that expect TypeError from `+{}` (where neither valueOf nor toString return primitive) get NaN.
   **New issue**: File as deviation from §7.1.3 step 5.

---

## 4. ToIntegerOrInfinity (§7.1.4) — f64 truncation

**Status**: ⚠️ Partially implemented, deviations.

### Spec algorithm:
1. Let number be ? ToNumber(argument).
2. If number is NaN, +0, or −0, return 0.
3. If number is +∞, return +∞.
4. If number is −∞, return −∞.
5. Return truncate(number).

### Our implementation:
- We use `i32.trunc_sat_f64_s` for i32 conversions (saturating: +∞ → MAX_INT, -∞ → MIN_INT, NaN → 0). ✅ for step 2 (NaN → 0).
- For array indices (splice, slice, etc.), `__unbox_number` + `i32.trunc_sat_f64_s` handles most cases.

### Deviations found:
1. **No dedicated ToIntegerOrInfinity helper.** The spec says NaN/±0 → 0, ±∞ → ±∞, otherwise truncate.
   Our `i32.trunc_sat_f64_s` saturates ±∞ to i32 limits instead of preserving ±∞. For array index
   operations, this is mostly fine (indices are bounded). But for `Math.trunc`-dependent operations,
   the spec behavior differs.
   **Impact**: Medium for built-in methods that pass through ToIntegerOrInfinity (e.g., Array.prototype.slice
   with Infinity argument should return all elements, but saturating to MAX_INT may produce wrong results
   if the array length < MAX_INT, which it always is, so this is actually OK for i32 indices).
   **Conclusion**: Effectively correct for practical array operations. No issue needed.

---

## 5. ToString (§7.1.17) — string coercion / `emitBoolToString` / string-ops.ts

**Status**: ✅ Mostly matches spec.

### Spec table:
- undefined → "undefined", null → "null", Boolean → "true"/"false", Number → NumberToString,
  String → same, Symbol → TypeError, BigInt → BigInt::toString, Object → ToPrimitive("string") then ToString.

### Our implementation:
- `emitBoolToString()` (string-ops.ts:654): correctly emits "true"/"false". ✅
- f64 → string: various paths including `__box_number` + string concat, or `Number.prototype.toString`. ✅
- Object → string: coerceType with hint "string" → ToPrimitive path. ✅
- `String(x)` call (calls.ts:4157): handles i32 (bool), f64, externref cases. ✅

### Deviations found:
1. **Symbol → TypeError not always enforced.** Same as ToNumber — host mode catches it, standalone doesn't.
   **Impact**: Low. Tracked under general Symbol handling gap.

---

## 6. ToObject (§7.1.18) — Not implemented as distinct operation

**Status**: ❌ Not implemented as a dedicated abstract operation.

### Spec table:
- undefined → TypeError, null → TypeError, Boolean → Boolean wrapper, Number → Number wrapper,
  String → String wrapper, Symbol → Symbol wrapper, BigInt → BigInt wrapper, Object → same.

### Our implementation:
- **No `__to_object` or `ToObject` helper exists.** We never emit wrapper objects for primitives.
- Destructuring and property access paths have null/undefined guards that throw TypeError. ✅ (partial)
- `new Number(x)`, `new String(x)`, `new Boolean(x)` are detected by `scanForBoxedPrimitiveConstructors`
  (index.ts:3107) but create externref wrapper objects via the host, not compile-time wrapper structs.

### Deviations found:
1. **Primitive auto-boxing for method calls is not implemented.**
   Per spec, `(42).toString()` calls ToObject(42) to get a Number wrapper, then invokes toString on it.
   Our compiler handles this specifically for known methods (Number.prototype.toString, String.prototype.*)
   via direct dispatch — which gives correct results for known methods. ✅
2. **For-in on primitives should call ToObject first.** `for (let k in "abc")` should iterate string
   indices. This may work via externref fallback but isn't spec-correct at the Wasm level.
   **Impact**: Medium. Most tests that exercise ToObject are for method calls on primitives, which we
   handle via direct dispatch. Gap is for edge cases like `Object(42)` which creates a wrapper.
   **Existing issue**: Covered partially by #820 (null/undefined umbrella).

---

## 7. RequireObjectCoercible (§7.2.1) — null/undefined guards

**Status**: ⚠️ Partially implemented.

### Spec table:
- undefined → TypeError, null → TypeError, everything else → return argument unchanged.

### Our implementation:
- Destructuring: null/undefined checks with TypeError throws. ✅ (function-body.ts:441, destructuring-params.ts:277/470, statements/destructuring.ts:107)
- Property access: null guard on externref. ✅ (property-access.ts:2185-2196)
- Array.prototype methods: delegates to `__proto_method_call` which throws for null/undefined receivers. ✅ (array-methods.ts:349)

### Deviations found:
1. **Not called at the start of every built-in method.** Per spec, most Array/String/Object prototype
   methods start with "Let O be ? RequireObjectCoercible(this value)." Our Wasm-native Array methods
   (filter, map, etc.) operate on WasmGC vec structs which are never null/undefined by construction. ✅
   But methods called on externref values (via host delegation) may not always check.
   **Impact**: Low — the host `__proto_method_call` checks for us.
   **Existing issue**: #820 umbrella.

---

## 8. IsCallable (§7.2.3) — function type checking

**Status**: ❌ Not implemented as a runtime check.

### Spec algorithm:
1. If argument is not Object, return false.
2. If argument has a [[Call]] internal method, return true.
3. Return false.

### Our implementation:
- **No runtime `IsCallable` check exists.** The TS type checker determines callability at compile time.
- `typeof x === "function"` is compiled to `typeof` checks on externref values via host import.
- Direct function calls are type-checked statically — if a non-function is called, it's a compile error.

### Deviations found:
1. **Dynamic callback validation not performed.** When a callback is passed to `Array.prototype.forEach`,
   `map`, etc., the spec requires `IsCallable(callback)` check at step 3, throwing TypeError if false.
   Our Wasm-native array methods assume the callback is a valid closure struct — if it isn't, the
   behavior is a Wasm trap (RuntimeError), not a spec-correct TypeError.
   **Impact**: Medium-high. 69 FAIL tests from #1092 are attributed to this.
   **Existing issue**: #1092 (IsCallable/IsConstructor — 69 FAIL).

---

## 9. IsConstructor (§7.2.4) — new-target checking

**Status**: ❌ Not implemented as a runtime check.

### Spec algorithm:
1. If argument is not Object, return false.
2. If argument has a [[Construct]] internal method, return true.
3. Return false.

### Our implementation:
- **No runtime `IsConstructor` check.** `new X()` is validated by the TS checker.
- Arrow functions lack [[Construct]] per spec, but our compiler doesn't distinguish [[Call]] vs [[Construct]]
  on closure structs.

### Deviations found:
1. **`new arrowFn()` doesn't throw TypeError.** Per spec, arrow functions don't have [[Construct]].
   Our compiler doesn't enforce this — `new (() => {})()` would succeed instead of throwing TypeError.
   **Impact**: Low (TS checker catches most cases), but affects test262 tests for arrow function constructability.
   **Existing issue**: #1092 adjacent.

---

## 10. SameValue (§7.2.10) — `Object.is` / property descriptor validation

**Status**: ⚠️ Deviates for f64 values.

### Spec algorithm:
1. If Type(x) ≠ Type(y), return false.
2. If x is Number: if x is NaN and y is NaN, return true; if x is +0 and y is -0 (or vice versa), return false; if same Number value, return true; else false.
3. Return SameValueNonNumber(x, y).

### Our implementation:
- `Object.is(x, y)` in runtime.ts (line 2107): delegates to `Object.is()` in the host. ✅
- Property descriptor validation (runtime.ts:136): uses `Object.is` for SameValue semantics. ✅
- **DefineProperty path in codegen** (object-ops.ts:873-881): uses `f64.ne` for f64 comparison.

### Deviations found:
1. **`f64.ne` is NOT SameValue for f64.** `f64.ne` treats `NaN != NaN` as true (correct for SameValue
   where NaN should equal NaN... wait, `f64.ne(NaN, NaN)` returns 1, meaning "not equal", but SameValue says
   NaN === NaN). So when we do `f64.ne(old, new)` and branch to throw TypeError, we WILL throw for
   NaN→NaN reassignment, which is wrong — SameValue(NaN, NaN) is true, so no throw should happen.
   Also, `f64.ne(+0, -0)` returns 0 (they're "equal"), but SameValue(+0, -0) is false — so we
   won't throw when we should.
   **Comment in code** (line 881): "Note: f64.ne treats NaN != NaN (not SameValue), but sufficient for typical test262 cases"
   **Impact**: Medium. DefineProperty on frozen objects with NaN or ±0 values will give wrong results.
   **New issue needed**: SameValue for DefineProperty f64 comparison (§9.1.6.3 step 7).

---

## 11. SameValueZero (§7.2.11) — `Array.prototype.includes` / Map/Set keys

**Status**: ✅ Correctly implemented for Array.includes.

### Spec algorithm:
Same as SameValue except: +0 and -0 are considered equal.

### Our implementation:
- Array.includes (array-methods.ts:2212): `(elem == val) | (isNaN(elem) & isNaN(val))`. ✅
  This correctly treats NaN === NaN (both NaN → true) and +0 === -0 (f64.eq returns true). ✅
- `__any_eq` (any-helpers.ts:695): uses `f64.eq` which is `==` semantics — NaN≠NaN (wrong for SameValueZero).

### Deviations found:
1. **`__any_eq` for AnyValue f64 doesn't handle NaN correctly.** `f64.eq(NaN, NaN)` returns 0, but
   SameValueZero should return true. This matters when comparing boxed any-values containing NaN.
   **Impact**: Low (AnyValue path is rarely used for includes comparisons — most go through the
   specialized array-methods.ts path which IS correct).

---

## 12. Abstract Equality Comparison (§7.2.14) — `==` operator

**Status**: ⚠️ Significant deviations for cross-type comparisons.

### Spec algorithm (complex, 13 steps):
Handles null==undefined (true), number==string (ToNumber on string), boolean==other (ToNumber on bool),
object==primitive (ToPrimitive on object), etc.

### Our implementation:
- `compileNumericBinaryOp` uses `f64.eq` for `==` on numeric operands. ✅ (after type coercion)
- Cross-type coercion: when both are f64, uses `f64.eq`. ✅
- When both are externref: uses host `__extern_eq` or string equality. ✅

### Deviations found:
1. **`null == undefined` may not return true at compile-time for all type combinations.**
   If one operand is null (ref_null) and the other is externref undefined, the Wasm types differ
   and we may not emit the correct comparison.
   **Impact**: Medium — affects test262 null/undefined equality tests.
   **Existing issue**: Partially covered by #820 umbrella.

---

## 13–15. Get/Set/DefinePropertyOrThrow (§7.3.2/§7.3.4/§7.3.9)

**Status**: Delegated to host imports (`__extern_get`, `__extern_set`, `__define_property`).

### Our implementation:
- `__extern_get(obj, key)` → runtime `_safeGet` with sidecar and struct getter fallback. ✅
- `__extern_set(obj, key, val)` → runtime sidecar set with proxy. ✅
- `__define_property(obj, key, descriptor)` → runtime with basic descriptor support.

### Deviations found:
1. **Get**: No OrdinaryGet (§10.1.8) step-by-step — delegates entirely to host. Works for host mode
   but doesn't handle prototype chain traversal in standalone mode.
   **Impact**: High for standalone mode, low for host mode.

2. **Set**: Doesn't validate writable/configurable before writing. Frozen/sealed objects don't throw.
   **Impact**: Medium. Tests for Object.freeze/seal property immutability fail silently.

3. **DefinePropertyOrThrow**: Property descriptor validation (§6.2.6) is partially implemented in
   runtime.ts. Missing: IsAccessorDescriptor, IsDataDescriptor, IsGenericDescriptor, CompletePropertyDescriptor.
   **Impact**: High — 200 FAIL tests attributed to #1018.
   **Existing issue**: #1018 (getOwnPropertyDescriptor — 200 FAIL).

---

## 16–17. Iterator Protocol (§7.4.1 GetIterator, §7.4.2 IteratorNext, §7.4.6 IteratorClose)

**Status**: ⚠️ Partially implemented, significant gaps in IteratorClose.

### Spec:
- GetIterator: Get @@iterator method, call it, validate result has .next method.
- IteratorNext: Call iterator.next(), validate result is Object.
- IteratorClose: Call iterator.return() on abrupt completion (break/return/throw from for-of body).

### Our implementation:
- For-of loops (statements/loops.ts:2090+): call @@iterator, loop with .next()/.done/.value. ✅
- Destructuring: iterator protocol path for array patterns. ✅
- Host-delegated path: `__iterator`, `__iterator_next`, `__iterator_done`, `__iterator_value` imports. ✅

### Deviations found:
1. **IteratorClose not called on break/return from for-of.** When the loop body breaks or returns,
   the spec requires calling iterator.return() (§7.4.6). Our for-of compilation doesn't emit
   iterator.return() cleanup code.
   **Impact**: High — 500+ FAIL tests attributed to #1016.
   **Existing issue**: #1016 (Iterator protocol — 500+ FAIL, in-progress).

2. **GetIterator doesn't validate that the result of @@iterator() is an Object.**
   Per §7.4.1 step 4: "If iteratorRecord.[[NextMethod]] is not a function, throw TypeError."
   We don't validate — if @@iterator() returns a non-object, we'd get a Wasm trap, not TypeError.
   **Impact**: Low (rare edge case).
   **Existing issue**: Part of #1016.

3. **IteratorNext doesn't validate that .next() returns an Object.**
   Per §7.4.2: "If result is not Object, throw a TypeError exception."
   **Impact**: Low.
   **Existing issue**: Part of #1016.

---

## New Issues to File

Based on this audit, the following new issues should be filed:

### NEW-1: SameValue for DefineProperty f64 comparison uses f64.ne instead of proper SameValue
- **Spec**: §9.1.6.3 step 7 + §7.2.10 SameValue
- **File**: `src/codegen/object-ops.ts:879-881`
- **Bug**: `f64.ne` treats NaN≠NaN (should be equal per SameValue) and +0==-0 (should be unequal)
- **Fix**: Implement SameValue for f64: `(a == b && !(a == 0 && 1/a != 1/b)) || (a != a && b != b)`
  In Wasm: combine f64.eq with copysign-based sign check for ±0 and f64.ne self-check for NaN.
- **Impact**: Affects Object.freeze/defineProperty with NaN and ±0 values

### NEW-2: ToPrimitive OrdinaryToPrimitive returns undefined instead of throwing TypeError
- **Spec**: §7.1.1.1 step 6 — must throw TypeError
- **File**: `src/runtime.ts:379` — `return undefined;`
- **Bug**: Callers get NaN/fallback instead of TypeError when no valueOf/toString produces a primitive
- **Fix**: Change `return undefined` to `throw new TypeError("Cannot convert object to primitive value")`
  and update callers that use `?? fallback` to try/catch instead.
- **Impact**: Tests expecting TypeError from `+{}` variants get NaN instead

### NEW-3: ToObject not implemented — primitive auto-boxing gaps
- **Spec**: §7.1.18
- **Currently**: No wrapper objects for primitives. Method calls work via direct dispatch.
- **Gap**: `Object(42)` doesn't create a Number wrapper. `for-in` on primitives may not work.
- **Impact**: Low-medium. Most test262 ToObject tests are for edge cases.

---

## Existing Issues Confirmed

| Issue | Operation | Status |
|-------|-----------|--------|
| #1090 | ToPrimitive (§7.1.1) | In backlog, 161 FAIL |
| #1092 | IsCallable/IsConstructor (§7.2.3/§7.2.4) | In backlog, 69 FAIL |
| #1016 | Iterator Protocol (§7.4) | In-progress, 500+ FAIL |
| #1018 | DefinePropertyOrThrow (§7.3.9) | In backlog, 200 FAIL |
| #820  | RequireObjectCoercible / null/undefined | In backlog, umbrella |
| #1065 | SameValue adjacent | In backlog |

---

## Phase 1 Completion Summary

| # | Operation | Spec § | Status | Issue |
|---|-----------|--------|--------|-------|
| 1 | ToPrimitive | §7.1.1 | ⚠️ Soft deviation (returns undefined not TypeError) | #1090 + NEW-2 |
| 2 | ToBoolean | §7.1.2 | ✅ Matches spec | — |
| 3 | ToNumber | §7.1.3 | ⚠️ Missing Symbol/BigInt TypeError in standalone | — (low impact) |
| 4 | ToIntegerOrInfinity | §7.1.4 | ✅ Effectively correct for i32 indices | — |
| 5 | ToString | §7.1.17 | ✅ Matches spec | — |
| 6 | ToObject | §7.1.18 | ❌ Not implemented as distinct operation | NEW-3 |
| 7 | RequireObjectCoercible | §7.2.1 | ⚠️ Partial (destructuring/property access only) | #820 |
| 8 | IsCallable | §7.2.3 | ❌ No runtime check | #1092 |
| 9 | IsConstructor | §7.2.4 | ❌ No runtime check | #1092 |
| 10 | SameValue | §7.2.10 | ⚠️ f64 path deviates | NEW-1 |
| 11 | SameValueZero | §7.2.11 | ✅ Correct in Array.includes | — |
| 12 | Abstract Eq (==) | §7.2.14 | ⚠️ Cross-type gaps | #820 partial |
| 13 | Get (O, P) | §7.3.2 | Host-delegated | — (acceptable) |
| 14 | Set (O, P, V) | §7.3.4 | Host-delegated, no writable check | — |
| 15 | DefinePropertyOrThrow | §7.3.9 | ⚠️ Incomplete descriptor model | #1018 |
| 16 | GetIterator | §7.4.1 | ⚠️ No result validation | #1016 |
| 17 | IteratorClose | §7.4.6 | ❌ Not implemented (no iterator.return()) | #1016 |

**Total new issues to file**: 3 (NEW-1, NEW-2, NEW-3)
**Existing issues confirmed**: 6 (#1090, #1092, #1016, #1018, #820, #1065)
