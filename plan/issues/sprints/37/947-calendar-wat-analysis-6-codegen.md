---
id: 947
title: "Calendar WAT analysis: 6 codegen inefficiencies found in the default playground example"
status: done
created: 2026-04-04
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: medium
reasoning_effort: high
goal: error-model
---
# #947 — Calendar WAT analysis: codegen inefficiencies in playground example

## Source
`playground/examples/dom/calendar.ts` — the default playground example (booking calendar).
Compiled: 10,278 bytes binary, 62,184 chars WAT, 19 functions.

## Issues found

### 1. Duplicate local declarations (all functions)

Every function declares locals twice — once with f64 type and once with i32 type:
```wat
(local $offset f64)     ;; line 743
...
(local $offset f64)     ;; line 772 — DUPLICATE
(local $i f64)          ;; line 748
...
(local $i i32)          ;; line 777 — same name, different type
```

`renderCal` has 60+ locals where half are duplicates. The compiler allocates locals in a pre-pass then again during codegen. The i32 versions are from native type inference; the f64 versions from the initial scan.

**Fix**: Deduplicate in the local allocation pass. When a local is re-allocated with a narrower type (i32 vs f64), reuse the existing index.

### 2. Modulo operator emits 10-instruction Infinity-guard sequence (dimOf)

`y % 400 === 0` compiles to:
```wat
local.get 0           ;; y
f64.const 400
local.set 2
local.set 3
local.get 2
f64.abs
f64.const Infinity
f64.eq               ;; check if 400 == Infinity
local.get 3
f64.abs
f64.const Infinity
f64.ne               ;; check if y != Infinity
i32.and
(if (result f64)
  (then local.get 3)  ;; return y if 400 is Infinity
  (else               ;; actual modulo
    local.get 3
    local.get 3
    local.get 2
    f64.div
    f64.trunc
    local.get 2
    f64.mul
    f64.sub
    local.get 3
    f64.copysign
  )
)
```

The Infinity check is correct per ES spec but **never triggers for integer literals**. When BOTH operands are known integer constants or integer-typed variables, the Infinity guard can be elided — just emit `f64.div + f64.trunc + f64.mul + f64.sub`.

**Source**: `dimOf(y, m)` at line 33: `if (y % 400 === 0) return 29;`
**Fix**: In modulo codegen, skip the Infinity guard when both operands are provably finite (integer literals, i32-typed vars, results of integer arithmetic).

### 3. Redundant `drop` after `local.tee` (el function)

```wat
local.get 1
local.tee 4
call 2          ;; CSSStyleDeclaration_set_cssText
local.get 4
drop            ;; WHY? local.tee already left value on stack AND saved to local
```

The `local.tee 4` + use + `drop` pattern appears when a variable assignment's result is unused. The peephole pass should eliminate `local.tee + ... + drop` → `local.set + ...`.

**Source**: `el()` at line 12: `e.style.cssText = css;`

### 4. TDZ flags on loop variables already proven safe

```wat
(local $day f64)
(local $__tdz_day i32)       ;; TDZ flag for 'day'
(local $cellBg externref)
(local $__tdz_cellBg i32)    ;; TDZ flag for 'cellBg'
```

`day` and `cellBg` are assigned inside the loop body before any closure capture. The `needsTdzFlag` analysis from #898 should eliminate these but it's not catching them in `renderCal`.

**Source**: `renderCal()` lines 90-91: `const day = d; const cellBg = bg;`
**Fix**: Extend `needsTdzFlag` to recognize closures that capture loop-body constants which are always initialized before the closure is created.

### 5. String concatenation chain creates excessive temporaries

The CSS string building in `renderCal`:
```js
"background:" + bg + ";color:" + fg + ";" + "border:" + border + ";transition:background 0.1s"
```
Compiles to 7 separate `call $concat_import` calls, each creating an intermediate string. A string builder pattern or template literal optimization would reduce this to 1-2 calls.

**Fix**: Detect chains of `+` with string operands and batch them into a single `__string_concat_n` host import that takes N arguments.

### 6. mname() uses 11 if-chains instead of br_table

```wat
local.get 0
f64.const 0
f64.eq
(if (then global.get 2 return))
local.get 0
f64.const 1
f64.eq
(if (then global.get 3 return))
...
```

The `mname(m)` function is a classic switch-on-integer pattern that should compile to `br_table` (a Wasm jump table). Instead it emits 11 sequential if-chains, each re-loading `local.get 0` and comparing against a constant.

**Source**: `mname()` lines 15-27.
**Fix**: Detect if-chain patterns where the same variable is compared against sequential integer constants and emit `br_table` instead.

## Priority

Items 2 (modulo Infinity guard) and 6 (br_table) are the highest-value optimizations — they affect every JS program with modulo or switch-like patterns. Items 1 (duplicate locals) and 3 (dead drops) are code quality improvements that reduce binary size.
