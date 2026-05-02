---
id: 932
title: "Landing page: replace performance score with JS feature coverage percentage"
status: done
created: 2026-04-03
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
goal: async-model
---
# #932 — Landing page: replace performance score with JS feature coverage percentage

## Problem

The landing page shows "313 — performance score on core benchmarks (100 = JS parity)". This is nuanced and misleading — a score >100 implies faster-than-JS which needs context. Visitors don't know what "core benchmarks" means or how the score is computed.

## Fix

Replace with a JS feature coverage percentage — how many ECMAScript language features the compiler implements. This is more intuitive and directly relevant to adoption decisions.

### How to compute

Count implemented vs total features from:
- test262 category breakdown (each category ≈ one ES feature area)
- Or manually enumerate: variables, functions, classes, destructuring, async/await, generators, iterators, Proxy, Symbol, Map/Set, WeakMap/WeakSet, Promise, RegExp, TypedArray, etc.
- A feature counts as "implemented" if >50% of its test262 tests pass

### What to show

`XX% — JavaScript language features implemented` where XX is derived from the test262 category data in `test262-report.json`.

## Additionally: benchmark performance chart

Add a bar chart showing Wasm execution time relative to native JS for core benchmarks (fib, array, string ops, etc.). Data from `benchmarks/results/playground-benchmark-sidebar.json`.

Each bar shows `benchmark name | Wasm time / JS time` as a horizontal bar where 100% = JS parity, >100% = faster than JS. Color-code: green if faster, amber if within 2x, red if >2x slower.

This replaces the single "313" number with a visual breakdown that shows where Wasm excels and where it's still catching up.

## Acceptance criteria

- Performance score number replaced with feature coverage percentage
- Benchmark performance chart added below the stats (horizontal bars, Wasm vs JS)
- Both load from JSON data (not hardcoded)
- Data loaded from test262-report.json and playground-benchmark-sidebar.json
- Tooltip or link to full breakdown on report page
