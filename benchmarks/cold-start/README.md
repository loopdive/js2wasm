# Cold-Start Benchmark

Compares fresh-process cold-start times across three execution paths:

1. **Wasmtime** — precompiled `.wasm` in `wasmtime run`
2. **Wasm-in-Node** — same `.wasm` loaded and instantiated in a fresh Node.js process
3. **JS-in-Node** — equivalent JavaScript source in a fresh Node.js process

## Methodology

Each measurement spawns a **fresh process** (no warm caches). Timing covers:
- **Total wall time**: process start to exit (measured by the parent)
- **Load time**: module load / Wasm instantiation (measured inside the child)
- **Execute time**: first call to the exported entrypoint (measured inside the child)

Each program is run `N` times (default 10) and the median is reported.

## Usage

```bash
node benchmarks/cold-start/run-cold-start.mjs [--runs N] [--program fib]
```

Results are written to `benchmarks/results/cold-start-<timestamp>.json`.

## Programs

Reuses programs from `benchmarks/competitive/programs/`. Each program exports
a `run(n)` function and a `benchmark` metadata object.
