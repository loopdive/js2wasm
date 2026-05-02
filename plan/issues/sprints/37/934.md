---
id: 934
title: "Array benchmark 1.31x slower than JS — unnecessary f64 conversions in loop codegen"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: performance
---
# #934 — Array benchmark 1.31x slower than JS — unnecessary f64 conversions in loop codegen

## Problem

The `bench_array` benchmark runs 1.31x slower than native JS (39.3µs vs 29.9µs). The compiled WAT reveals several codegen inefficiencies that should be eliminated:

### Source
```js
export function bench_array(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i++) arr.push(i);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total = total + arr[i];
  return total;
}
```

### WAT inefficiencies found

1. **f64↔i32 conversion churn in loop counters** — `i` is inferred as i32 (good) but the loop condition does `f64.convert_i32_s` + `f64.const 10000` + `f64.lt` instead of `i32.const 10000` + `i32.lt_s`. Same for `i < arr.length`.

2. **f64→i32 roundtrip for array indexing** — in the read loop, `arr[i]` compiles to `local.get $i` → `f64.convert_i32_s` → `i32.trunc_sat_f64_s` → `array.get`. The i32→f64→i32 roundtrip is pure waste since `i` is already i32.

3. **Redundant `drop` after `local.set`** — multiple places have `local.set N` followed by `drop` of dead values on the stack. The peephole pass should eliminate these.

4. **Push return value unused** — `arr.push(i)` returns the new length but the result is dropped. The codegen shouldn't compute it.

### Expected fix locations

- **Loop condition**: `src/codegen/statements.ts` — `compileForStatement` loop condition compilation should detect i32 comparands and emit `i32.lt_s` directly
- **Array indexing**: `src/codegen/expressions.ts` or `src/codegen/array-methods.ts` — element access should skip f64 conversion when index is already i32
- **Dead value elimination**: `src/codegen/peephole.ts` — `local.set` + `drop` pattern
- **Push return**: `src/codegen/array-methods.ts` — skip length return when result is unused (void context)

### Acceptance criteria

- `bench_array` ratio drops below 1.0x (Wasm at parity or faster than JS)
- No test262 regressions
- Loop counters use i32 arithmetic when type is known
- Array element access skips f64 roundtrip for i32 indices
