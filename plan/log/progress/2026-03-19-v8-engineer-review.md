# V8 Engineer Review — 2026-03-19

Review of ts2wasm's WasmGC code generation from the perspective of how V8's Wasm runtime would optimize and execute the output. Two parallel agents analyzed the codegen patterns, compiled output quality, and optimization opportunities.

## Executive Summary

The compiler generates **clean, idiomatic WasmGC code** that plays well with V8's optimizations. Direct struct access (1 instruction), monomorphic call sites, and bounds check elimination in for-loops are strong points. The main performance sinks are **f64 loop counters** (should be i32), **AnyValue boxing overhead** (4-5 calls per mixed-type operation), and **missing `final` type annotations** that prevent V8's devirtualization.

## What V8 Likes About This Output

### 1. Monomorphic call sites (A+)

Most function calls compile to direct `call funcIdx` — one instruction. V8's speculative inlining works best on monomorphic sites. Closure calls use `call_ref` through a typed funcref, which V8 can also inline. No `call_indirect` through function tables.

### 2. Direct struct field access (A+)

`obj.field` compiles to a single `struct.get $MyStruct fieldIdx` — no boxing, no indirection, no type check. This is optimal WasmGC usage. V8 maps struct fields directly to memory offsets.

### 3. Bounds check elimination (A)

The `safeIndexedArrays` pattern detects `for (let i = 0; i < arr.length; i++)` loops and eliminates bounds checks inside: `array.get` instead of 10-instruction bounds check sequence. Reduces hot loop overhead from 10 to 3 instructions per array access.

### 4. Inline Math (A-)

Transcendental functions (sin, cos, tan, exp, log, pow) are inlined as 200+ Wasm instructions each using Minimax polynomial approximation. Trades code size for avoiding import call overhead (~500μs per call). Good tradeoff for math-heavy code.

## What V8 Doesn't Like

### 5. f64 loop counters (D)

Loop counters use f64 arithmetic even for integer patterns:

```wasm
;; for (let i = 0; i < 10; i++)
local.get $i          ;; f64
f64.const 10.0        ;; f64
f64.lt                ;; f64 comparison!
i32.eqz
br_if 1

local.get $i
f64.const 1.0
f64.add               ;; f64 increment!
local.set $i
```

~13-15 instructions per iteration. With i32: ~9 instructions (30% reduction). V8 can't auto-promote f64 loops to i32 — the compiler must emit i32 from the start.

The "fast mode" (`--fast`) uses i32 by default, but test262 runs without it. Integer inference from TypeScript types (loop variable initialized to 0, compared with integer, incremented by 1) should trigger i32 automatically.

### 6. AnyValue boxing overhead (C-)

When types are heterogeneous (e.g., `number + unknown`):

```wasm
f64.convert_i32_s       ;; i32 → f64
call $__any_box_f64     ;; f64 → AnyValue struct
local.get $y            ;; unknown (AnyValue)
call $__any_add         ;; AnyValue binary dispatch
```

4-5 function calls per operation. V8 cannot inline across the `call` boundary easily. For hot paths with mixed types, this is the dominant cost.

### 7. No `final` type annotations (C)

Struct types for classes, closures, and objects are NOT marked `final`. This prevents V8 from:
- Devirtualizing known concrete types
- Eliminating redundant `ref.cast` / `ref.test` checks
- Inlining method calls with guaranteed monomorphism

Classes that are never subtyped (most of them) should be `final`. Closure structs should always be `final`.

### 8. Redundant ref.cast before call_ref (C+)

Closure calls emit `ref.cast` + `ref.as_non_null` before `call_ref`:

```wasm
local.get $closureVar
ref.cast $ClosureStruct       ;; redundant if type is statically known
ref.as_non_null               ;; redundant if already non-null
struct.get $ClosureStruct 0   ;; get funcref
call_ref $funcType
```

When the closure type is statically known from TypeScript types, the `ref.cast` is provably unnecessary. V8 validates it anyway but can't optimize it away.

### 9. Reference cell indirection for closures (B-)

Mutable closure captures use ref cells: `struct { field $value (mut T) }`. Every access is two `struct.get` instructions instead of one:

```wasm
local.get $self           ;; get closure struct
struct.get $Closure 1     ;; get ref cell
struct.get $RefCell 0     ;; get actual value
```

This is architecturally necessary but doubles the cost of captured variable access. For single-writer closures (one function writes, others only read), the ref cell could be eliminated.

### 10. No escape analysis (C-)

Every object literal, closure, and array creates a GC heap allocation via `struct.new` / `array.new`. V8 cannot stack-allocate WasmGC structs (Wasm spec limitation). Short-lived temporaries that are used once and discarded still go through the GC.

The compiler could reduce allocations by:
- Using locals for destructuring instead of intermediate arrays
- Inlining small closures at the call site instead of creating closure structs
- Reusing struct allocations for sequential object literals of the same shape

## Instruction Count Analysis

| Pattern | Instructions | Rating |
|---------|------------:|--------|
| `x + y` (both f64) | 3 | Optimal |
| `x + y` (mixed types) | 6-8 | Overhead from coercion |
| `obj.field` | 1 | Optimal |
| `arr[i]` (bounds checked) | 10 | Acceptable |
| `arr[i]` (bounds eliminated) | 3 | Optimal |
| `fn(x)` (direct call) | 1-2 | Optimal |
| `closure(x)` (call_ref) | 4-5 | Acceptable |
| For-loop iteration (f64) | 13-15 | Suboptimal |
| For-loop iteration (i32) | 9-10 | Good (fast mode only) |
| AnyValue dispatch | 4-5 calls | Poor |
| String concat | 1 call | Acceptable |

## Comparison With Other WasmGC Compilers

| Feature | ts2wasm | Dart (dart2wasm) | Kotlin/Wasm | Java (J2Wasm) |
|---------|---------|------------------|-------------|---------------|
| Struct finality | Not marked | Marked final | Marked final | Marked final |
| Call style | Direct + call_ref | Direct + interface dispatch | Direct + vtable | Direct + itable |
| Loop counters | f64 default | i32/i64 | i32 | i32 |
| GC pressure | High (closures, AnyValue) | Low (value types) | Medium | Low (escape analysis in J2CL) |
| Type precision | f64 unless --fast | Full type system | Full type system | Full type system |
| Bounds check elim | Yes (for-loops) | Yes (Binaryen) | Yes | Yes (J2CL) |
| String repr | Rope + extern | Extern | Extern | Extern |

ts2wasm's main disadvantage vs other WasmGC compilers: JavaScript's dynamic typing forces AnyValue boxing and f64-default behavior that statically-typed languages avoid entirely.

## Recommendations (priority order)

### High Impact

1. **Mark struct types `final`** — prevents V8 from using general subtype checks. Easy change in struct type registration. Estimated 5-10% improvement on method-heavy code.

2. **Integer loop inference** — detect `for (let i = 0; i < n; i++)` and emit i32 loop counter in default mode (not just --fast). 30% loop overhead reduction.

3. **Eliminate unnecessary ref.cast** — when TypeScript type is known, skip ref.cast before struct.get and call_ref. Reduces 2 instructions per access.

### Medium Impact

4. **Type-specialized arithmetic** — for `number + number`, emit direct `f64.add` without AnyValue dispatch. Only use AnyValue for truly `unknown` types.

5. **Single-writer ref cell elimination** — if only one function captures a mutable variable and all others read it, inline the value instead of ref cell.

6. **Hoist loop-invariant bounds checks** — extend bounds elimination beyond the `i < arr.length` pattern to any monotonic loop counter.

### Low Impact

7. **Constant folding at Wasm level** — `f64.const 1 + f64.const 2` → `f64.const 3`. TypeScript's checker does some of this but not all.

8. **Dead block elimination** — remove `block`/`end` wrappers around single-instruction sequences.

9. **Tail call optimization** — use `return_call` / `return_call_ref` for tail-recursive patterns (limited V8 support currently).

## Verdict

**The generated Wasm is B+ quality** for a dynamically-typed source language. It would be A quality for the statically-typed subset (i32 mode, known types, direct calls). The main gap vs other WasmGC compilers (Dart, Kotlin, Java) is that JavaScript's type system forces dynamic dispatch and boxing that those languages don't need. This is a language-level constraint, not a compiler quality issue.

The easiest wins — `final` types, i32 loop inference, and unnecessary ref.cast elimination — would close much of the gap with minimal effort. The hard wins (escape analysis, speculative optimization) would require V8-level cooperation or a multi-tier compilation strategy.
