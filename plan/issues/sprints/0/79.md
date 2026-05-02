---
id: 79
title: "Issue 79: Gradual typing — boxed `any` with runtime dispatch"
status: done
created: 2026-03-08
updated: 2026-04-14
completed: 2026-04-14
priority: low
goal: core-semantics
files:
  src/codegen/index.ts:
    new:
      - "AnyValue struct type definition and registration"
      - "__any_add, __any_sub, __any_mul etc. runtime dispatch helpers"
    breaking:
      - "type emission: add AnyValue tagged-union struct"
  src/codegen/expressions.ts:
    new:
      - "box/unbox coercion insertion for any-typed boundaries"
      - "typeof on any: tag field read"
    breaking:
      - "coerceType(): add any/unknown boxing paths"
      - "compileExpression(): handle any-typed operands with dispatch"
  src/codegen/statements.ts:
    new: []
    breaking:
      - "type narrowing: typeof checks on any emit tag-based branching"
---
# Issue 79: Gradual typing — boxed `any` with runtime dispatch

## Current status

**Mostly implemented (fast mode).** The core AnyValue infrastructure is in place:
- AnyValue struct type with tag/i32/f64/ref/extern fields
- Box/unbox helpers for all primitive types (null, undefined, i32, f64, bool, string, ref)
- Runtime dispatch for arithmetic (+, -, *, /, %), comparison (<, >, <=, >=), equality (==, ===, !=, !==)
- Unary negation on any
- typeof on any (tag-based comparison and standalone via native strings)
- Truthiness check (__any_unbox_bool) for conditionals
- Coercion between primitives and AnyValue in both directions

**Remaining gaps:**
- Only enabled in fast mode (non-fast mode uses externref for any due to host import conflicts)
- Property access on any values not yet implemented
- String concatenation on any values not yet implemented
- No type narrowing (typeof checks don't yet produce unboxed code in the narrowed branch)

## Summary

Support `any`, `unknown`, and dynamically-typed values by compiling them to a
boxed tagged-union representation in WasmGC, with runtime type dispatch for
operations. Statically-typed code remains fully static and fast.

## Motivation

Currently, any use of `any` or untyped values is a compile error. This blocks:

- Importing JS libraries that use `any` in their signatures
- Writing generic utility functions that accept arbitrary types
- Gradual migration of JS code to wasm
- Supporting `.d.ts` files that expose `any`-typed APIs

Every other TS-to-wasm compiler (Wasmnizer-ts, Zena) supports some form of
dynamic typing. Without it, we can't compile most real-world TypeScript.

## Design

### Boxed value representation

A boxed `any` value is a WasmGC struct with a type tag and a payload:

```
$AnyValue = (struct
  (field $tag i32)       ;; 0=null, 1=i32, 2=f64, 3=bool, 4=string, 5=object, 6=array, 7=function
  (field $i32val i32)    ;; used for i32, bool
  (field $f64val f64)    ;; used for f64
  (field $refval (ref null eq))  ;; used for string, object, array, function
)
```

Alternative: use WasmGC subtyping with a shared supertype and `ref.test`/`ref.cast`
for discrimination. This avoids wasting fields but requires more types.

### Boxing and unboxing

At boundaries between typed and `any`-typed code, the compiler inserts
box/unbox coercions:

```typescript
function typed(x: number): number { return x * 2; }
function dynamic(x: any): any { return x * 2; }

// Calling typed from dynamic context:
const result: any = typed(42);
// Compiles to: box_i32(call $typed (i32.const 42))

// Calling dynamic from typed context:
const n: number = dynamic(42);
// Compiles to: unbox_i32(call $dynamic (box_i32 (i32.const 42)))
```

### Runtime dispatch for operations

Operations on `any` values dispatch based on the tag:

```typescript
function add(a: any, b: any): any { return a + b; }
```

Compiles to:
```
;; Check tags of a and b
;; If both i32 → i32.add, box result
;; If both f64 → f64.add, box result
;; If either is string → concat, box result
;; Otherwise → trap or throw
```

This dispatch is implemented as wasm helper functions emitted once per module:
`__any_add`, `__any_sub`, `__any_mul`, `__any_eq`, `__any_lt`, `__any_get_prop`, etc.

### Property access on `any`

```typescript
function getLength(x: any): any { return x.length; }
```

For known property names on `any`, we need runtime property lookup. Two options:

**A. Host import** — Call out to JS to do the property access (like Wasmnizer-ts):
```wasm
(call $__any_get_prop (local.get $x) (string.const "length"))
```

**B. Vtable/interface dispatch** — If the runtime type is a known class, use
WasmGC's `ref.test` to check and `ref.cast` to access the field directly.

Option B is faster but only works for types we compiled. Option A is the
fallback for truly unknown types.

### Type narrowing on `any`

```typescript
function process(x: any) {
  if (typeof x === "number") {
    // x is narrowed to number here — unbox and use static i32 ops
    return x * 2;
  }
}
```

`typeof` checks on `any` compile to tag checks, and the narrowed branch uses
unboxed static operations. This is the key to making gradual typing fast:
well-typed code paths are zero-overhead.

### What `any` supports

| Operation | Implementation |
|-----------|---------------|
| Arithmetic (+, -, *, /, %) | Tag check → dispatch to typed op |
| Comparison (===, <, >) | Tag check → dispatch to typed compare |
| Property access (x.foo) | Host import or vtable lookup |
| Method call (x.foo()) | Host import or vtable dispatch |
| typeof | Read tag field |
| Type assertion (x as T) | Tag check → unbox or cast |
| Truthiness (if (x)) | Tag-dependent falsy check |
| String concatenation | Box both → string conversion → concat |

### What `any` does NOT support

| Operation | Why |
|-----------|-----|
| Arbitrary property creation | Would need a hashmap (separate issue #77) |
| Prototype chain access | No prototype model in wasm |
| `eval`, `Function` | No runtime code generation |

## Performance expectations

- Typed code: **zero overhead** (no boxing, same codegen as today)
- `any` operations: **5-10x slower** than typed (tag check + dispatch per op)
- Box/unbox at boundaries: **~2 instructions** per crossing
- Much faster than Wasmnizer-ts's approach (they cross the host boundary per
  operation; we stay in wasm)

## Complexity

XL — New type representation, box/unbox insertion pass, runtime dispatch
helpers (~20 operator functions), type narrowing integration, coercion rules.
~1000 lines. Can be implemented incrementally: start with `any` for primitives,
then add object/array support.

## Dependencies

| Issue | Relationship |
|-------|-------------|
| **#77** | Object literals — dynamic property access on objects |
| **#78** | Standard library — `typeof`, type coercion helpers |
| **#41** | typeof expression — extends to work on `any` values |

## Implementation Summary (2026-03-16)

### What was done
1. **Fixed null/undefined boxing for AnyValue**: Added fast-path in `compileExpression` that emits `__any_box_null`/`__any_box_undefined` instead of `ref.null.extern` when the expected type is AnyValue. This prevents Wasm type errors at boundaries.
2. **Fixed boolean boxing for AnyValue**: Added handling so `true`/`false` literals and boolean-typed expressions use `__any_box_bool` (tag=4) instead of `__any_box_i32` (tag=2). This preserves correct runtime `typeof` behavior.
3. **Removed redundant `ctx.fast` guards**: The `isAnyValue()` check already returns false in non-fast mode (since `anyValueTypeIdx` is -1), so the `ctx.fast` guards on binary dispatch, typeof comparison, and unary negation were redundant.
4. **Added 17 new equivalence tests**: Covering conditionals, ternary, strict equality, compound assignment, null/undefined boxing, boolean boxing, typeof tag checks, unary plus, double negation, variable reassignment, while loops, and function parameter passing.

### What worked
- The existing AnyValue infrastructure is solid and well-designed
- Removing `ctx.fast` guards from dispatch code is safe because `isAnyValue()` is the true gate
- Boolean tag preservation enables correct `typeof a === "boolean"` runtime checks

### What didn't work (investigated but deferred)
- Enabling AnyValue for non-fast mode: TypeScript returns `intrinsicName="any"` for both explicit `any` annotations AND unresolved property accesses on imported objects, making it impossible to distinguish them using type flags alone. Non-fast mode still uses externref for `any`.

### Files changed
- `src/codegen/expressions.ts`: Added null/undefined/boolean AnyValue fast-path, boolean coercion fix, removed `ctx.fast` guards
- `src/codegen/index.ts`: Updated comment on `resolveWasmType` any/unknown handling
- `tests/equivalence/gradual-typing.test.ts`: Added 17 new test cases (34 total, all passing)
