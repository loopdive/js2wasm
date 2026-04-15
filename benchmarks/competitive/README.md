# Competitive Runtime Benchmarks

This benchmark harness compares the same JavaScript benchmark programs across:

- native JavaScript in Node.js
- `js2wasm` output running in Node.js with the standard JS host bridge
- `js2wasm` output prepared for Wasmtime
- AssemblyScript equivalents prepared for Wasmtime
- Javy's static QuickJS runtime running the same JS in Wasmtime
- Porffor running through its own Node.js runtime/compiler path
- StarlingMonkey's runtime-eval component running the same JS in Wasmtime

## What it measures

- module size
- gzip-compressed module size
- precompiled Wasmtime artifact size
- compiler footprint size
- runtime/helper footprint size
- compile time to the runnable artifact used by that lane
- cold start time for a fresh process and first invocation
- amortized hot runtime per call inside one loaded process/module
- estimated compute-only time per call after subtracting a single-call process run

The Wasmtime side uses:

- `wasm-opt --all-features -O4`
- `wasmtime compile -W gc=y,gc-support=y,function-references=y,exceptions=y -O opt-level=2`
- `wasmtime run -W gc=y,gc-support=y,function-references=y,exceptions=y --allow-precompiled`

This is a best-effort approximation of a production precompiled deployment
profile. It is not a claim that Fastly uses exactly these public CLI flags.

The Node-hosted `js2wasm` lane is intentionally different:

- target: `gc`
- `fast: true`
- instantiated inside Node.js with the normal `js2wasm` JS host bridge

`Compile ms` means:

- `js2wasm`: compiler lowering + `wasm-opt`, and for Wasmtime also `wasmtime compile`
- AssemblyScript: `asc` + `wasm-opt` + `wasmtime compile`
- Javy: `javy build` + `wasmtime compile`
- Porffor: the module-mode wasm compile used for size reporting
- StarlingMonkey: precompiling the vendored runtime component with Wasmtime

`Compiler bytes` means the main compiler asset footprint used by that lane.

`Runtime/helper bytes` means extra runtime or host helper assets required by
that lane beyond the generated benchmark module size.

- `js2wasm`: `scripts/compiler-bundle.mjs`
- `js2wasm` hosted runtime/helper: `benchmarks/competitive/run-node-wasm-program.mjs`
- AssemblyScript: vendored AssemblyScript compiler distribution
- Javy: vendored `javy` binary, with `plugin.wasm` counted as runtime/helper bytes
- Porffor: vendored `compiler/` tree, with `runtime/` counted separately
- StarlingMonkey: vendored Wasmtime binary, with `starling.wasm` counted separately

The hot-runtime metric is measured by:

- loading the program or module once in a fresh process
- doing one warm-up call
- running repeated calls inside that same loaded process or module
- dividing wall-clock duration by the configured hot iteration count

For `Node.js` and `js2wasm -> Node.js`, the compute-only metric is measured by:

- loading once in a fresh process
- doing one warm-up call
- timing only the repeated in-process calls
- dividing the internal timed section by the configured hot iteration count

For the Wasmtime lanes, compute-only is still estimated as:

- `compute_only ~= hot_runtime - (single_call_runtime / iterations)`

This keeps the Wasmtime paths comparable without introducing a custom host
harness there yet.

## Usage

```bash
pnpm run benchmark:competitive
```

Outputs:

- `benchmarks/results/runtime-compare-latest.json`
- `benchmarks/results/runtime-compare-latest.md`
- timestamped copies in the same directory

## StarlingMonkey

The benchmark repo now vendors a pinned StarlingMonkey checkout at:

- `vendor/StarlingMonkey`

Current pinned revision:

- `9dda8ba7fcda2e17c6795d402f0478cf4c1f7f37`

The harness uses StarlingMonkey's documented runtime-eval flow:

- `starling.wasm` for runtime evaluation of JS inside Wasmtime

For each benchmark program, the harness generates a small wrapper script that:

- imports `run` from the benchmark module
- executes `run(input)` once for cold and single-call timing
- or loops inside the same StarlingMonkey process for hot timing
- prints the numeric result through `console.log`

This means the StarlingMonkey lane measures the runtime-eval component, not a
benchmark-specific compiled module.

## StarlingMonkey adapter

The repo does not assume a specific StarlingMonkey CLI. To enable that path, set:

```bash
export STARLINGMONKEY_ADAPTER=/absolute/path/to/adapter-script
```

The adapter script must support:

```bash
$STARLINGMONKEY_ADAPTER <input.js> <output.wasm>
```

and write a Wasm module to `<output.wasm>`.

The adapter path is now only needed if you want to compare against a different
StarlingMonkey compilation flow than the vendored runtime-eval component.

## Javy

The harness uses the vendored Javy CLI at:

- `vendor/Javy/javy`

Current pinned release:

- `v8.1.1`

For each benchmark program, the harness generates a wrapper script that:

- inlines the benchmark program source
- reads `{ input, iterations }` as JSON from stdin through `Javy.IO`
- executes `run(input)` once or in a hot loop
- writes the numeric result to stdout

The Javy lane currently uses the default static runtime build, so its module
size includes the bundled QuickJS runtime.

## AssemblyScript

The harness uses the vendored AssemblyScript CLI at:

- `vendor/AssemblyScript/node_modules/.bin/asc`

Current pinned release:

- `v0.28.14`

This lane is not source-identical JavaScript. The harness translates each
benchmark kernel into a small typed AssemblyScript equivalent and compiles it
with:

- `-O3 --converge --runtime stub --noAssert`
- followed by `wasm-opt -O4`

## Porffor

The harness uses the vendored Porffor checkout at:

- `vendor/Porffor`

Current pinned revision:

- `84fdcda4741ed2ee1383ae65e15743869cd6c017`

Porffor's raw wasm output is not a drop-in WASI/Wasmtime target, so the harness
measures Porffor through its own module compiler/runtime path in Node.js:

- cold start: fresh process compile + instantiate + first call
- hot runtime: fresh process with one compile/instantiate and repeated calls
- compute-only: internal timed repeated calls after warm-up

For size reporting, the harness still emits Porffor's wasm output with:

- `--module -O3`
- followed by `wasm-opt -O4`
