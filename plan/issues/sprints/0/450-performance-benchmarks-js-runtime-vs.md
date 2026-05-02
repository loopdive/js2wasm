---
id: 450
title: "Performance benchmarks: JS runtime vs precompiled Wasm"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: standalone-mode
required_by: [454]
---
# #450 — Performance benchmarks: JS runtime vs precompiled Wasm

## Problem
We have no data on how our compiled Wasm compares to native JS execution in terms of performance. We need benchmarks that measure the same workloads across:

1. **JS in V8** (Node.js or browser)
2. **Precompiled Wasm in V8** (same Node.js/browser via WebAssembly)
3. **Precompiled Wasm in wasmtime** (standalone Wasm runtime)

## Requirements
- Create a benchmark suite of representative workloads:
  - Numeric computation (fibonacci, matrix multiply, sorting)
  - String processing (parsing, template rendering)
  - Object-heavy code (tree traversal, JSON manipulation)
  - Real-world patterns (array transforms, reduce/map chains)
- Each benchmark runs the same TS source compiled to Wasm via ts2wasm, and the same source run natively in Node.js
- Measure: execution time, startup time (compile+instantiate), memory usage
- Compare across V8 (Node.js), browser (Chrome), and wasmtime
- Output results as JSON, render in `benchmarks/report.html`

## Acceptance Criteria
- At least 10 benchmarks covering different workload types
- Results show median + p95 across multiple runs
- Report visualizes JS vs Wasm performance ratio per benchmark
