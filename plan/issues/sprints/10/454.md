---
id: 454
title: "Compile pako (zlib) to Wasm and benchmark vs JS"
status: done
created: 2026-03-17
updated: 2026-04-14
completed: 2026-04-14
priority: medium
goal: ci-hardening
depends_on: [450]
---
# #454 — Compile pako (zlib) to Wasm and benchmark vs JS

## Problem
pako is a pure-JS zlib implementation — tight loops over byte arrays, zero dependencies, CPU-bound. It's an ideal candidate for demonstrating Wasm performance gains from ts2wasm and validating real-world compilation.

## Requirements
- Compile pako (`pako` npm package) to Wasm via ts2wasm
- Validate correctness: compress with Wasm, decompress with JS (and vice versa)
- Benchmark against native JS pako:
  - Deflate: various input sizes (1KB, 100KB, 1MB, 10MB)
  - Inflate: same sizes
  - Different compression levels (1, 6, 9)
  - Measure throughput (MB/s), startup time, memory usage
- Run benchmarks in Node.js (V8) and wasmtime
- Compare against native zlib (Node.js `zlib` module) as baseline

## Acceptance Criteria
- pako deflate + inflate compile to Wasm and produce correct output
- Benchmark results showing Wasm vs JS throughput ratio
- Results integrated into `benchmarks/report.html`
