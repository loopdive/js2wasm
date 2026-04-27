# Runtime Comparison Benchmarks

This benchmark harness compares the same JavaScript benchmark programs across:

- native JavaScript in Node.js
- `js2wasm` output running in Node.js with the standard JS host bridge
- `js2wasm` output prepared for Wasmtime
- AssemblyScript equivalents prepared for Wasmtime
- Javy's static QuickJS runtime running the same JS in Wasmtime
- Porffor running through its own Node.js runtime/compiler path
- StarlingMonkey's runtime-eval component running the same JS in Wasmtime
- a benchmark-specific StarlingMonkey + ComponentizeJS lane (Wizer pre-init +
  Weval AOT specialization) running in Wasmtime

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
- `wasmtime compile -W gc=y,function-references=y,component-model=y,exceptions=y -O opt-level=2`
- `wasmtime run -W gc=y,function-references=y,component-model=y,exceptions=y --allow-precompiled`

The harness is verified against the latest stable wasmtime release at the
time of each run (most recently `wasmtime 44.0.0`). The floor is wasmtime
40, because the StarlingMonkey + ComponentizeJS lane depends on wasmtime
40's component-model `--invoke "fn(args)"` parenthesized syntax — earlier
wasmtimes (30, 31) reject `--invoke` against components.

`-W exceptions=y` is required for the StarlingMonkey + ComponentizeJS lane
because ComponentizeJS-emitted components use SpiderMonkey's Wasm
exception-handling machinery. `gc-support=y` (a pre-v31 flag) was
collapsed into `gc=y` upstream and is no longer set by the harness.

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
- StarlingMonkey runtime-eval: precompiling the vendored runtime component with Wasmtime
- StarlingMonkey + ComponentizeJS: adapter compilation plus `wasmtime compile`

`Compiler bytes` means the main compiler asset footprint used by that lane.

`Runtime/helper bytes` means extra runtime or host helper assets required by
that lane beyond the generated benchmark module size.

- `js2wasm`: `scripts/compiler-bundle.mjs`
- `js2wasm` hosted runtime/helper: `benchmarks/competitive/run-node-wasm-program.mjs`
- AssemblyScript: the configured `asc` toolchain path
- Javy: the configured `javy` binary, with `plugin.wasm` counted as runtime/helper bytes
- Porffor: the configured `compiler/` tree, with `runtime/` counted separately
- StarlingMonkey runtime-eval: the configured Wasmtime binary, with `starling.wasm` counted separately
- StarlingMonkey + ComponentizeJS: adapter-specific assets reported via metadata when available

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

The harness can run against externally managed external toolchain checkouts and binaries.
Vendoring them into this repository is optional and not required.

If you want the historical local `vendor/` fallback layout back, recreate it with:

```bash
pnpm run setup:benchmark-vendors
```

`vendor/` is intentionally gitignored. It is a local cache for benchmark toolchains,
not source of truth.

## External toolchain setup

The benchmark runner honors environment variables for every non-js2wasm lane.
Point them at local checkouts or installed binaries before running the suite.

### Required local tools

- `wasmtime`
- `wasm-opt`
- `node`
- `pnpm`

### Optional external toolchains

```bash
# Javy
export JAVY_BIN=/absolute/path/to/javy
export JAVY_PLUGIN=/absolute/path/to/plugin.wasm

# AssemblyScript
export ASSEMBLYSCRIPT_ROOT=/absolute/path/to/AssemblyScript
export ASSEMBLYSCRIPT_ASC=/absolute/path/to/asc

# Porffor
export PORFFOR_ROOT=/absolute/path/to/Porffor
export PORFFOR_WRAP=/absolute/path/to/Porffor/compiler/wrap.js
export PORFFOR_RUNTIME_BIN=/absolute/path/to/Porffor/runtime/index.js

# StarlingMonkey runtime-eval lane
export STARLINGMONKEY_ROOT=/absolute/path/to/StarlingMonkey
export STARLINGMONKEY_BUILD_DIR=/absolute/path/to/StarlingMonkey/cmake-build-release
export STARLINGMONKEY_RUNTIME=/absolute/path/to/StarlingMonkey/cmake-build-release/starling.wasm
export STARLINGMONKEY_WASMTIME_BIN=/absolute/path/to/wasmtime

# StarlingMonkey + ComponentizeJS (Wizer + Weval) lane
# As of #1125 the harness auto-uses the bundled adapter at
#   benchmarks/competitive/sm-componentize-adapter.mjs
# whenever @bytecodealliance/componentize-js is installed (it ships in
# devDependencies). You only need to set this if you want to point at a
# different adapter implementation.
export STARLINGMONKEY_ADAPTER=$PWD/benchmarks/competitive/sm-componentize-adapter.mjs

# Optional: opt out of Weval AOT specialization (Wizer pre-init still runs)
export STARLINGMONKEY_COMPONENTIZE_AOT=0

# Optional: explicit Wizer / Weval binaries (otherwise the bundled
# @bytecodealliance/wizer + @bytecodealliance/weval are used)
export STARLINGMONKEY_WIZER_BIN=/absolute/path/to/wizer
export STARLINGMONKEY_WEVAL_BIN=/absolute/path/to/weval
```

The benchmark script falls back to `vendor/...` paths only if those exist and no
environment override is provided. That keeps local private benchmarking
convenient without making vendored trees part of the committed benchmark story.

For Javy specifically, the helper script cannot infer the correct binary for every
platform. If you want it staged under `vendor/Javy`, provide:

```bash
JAVY_BIN_SOURCE=/path/to/javy \
JAVY_PLUGIN_SOURCE=/path/to/plugin.wasm \
pnpm run setup:benchmark-vendors
```

Outputs:

- `benchmarks/results/runtime-compare-latest.json`
- `benchmarks/results/runtime-compare-latest.md`
- timestamped copies in the same directory

## StarlingMonkey

The harness uses StarlingMonkey's documented runtime-eval flow:

- `starling.wasm` for runtime evaluation of JS inside Wasmtime

For each benchmark program, the harness generates a small wrapper script that:

- imports `run` from the benchmark module
- executes `run(input)` once for cold and single-call timing
- or loops inside the same StarlingMonkey process for hot timing
- prints the numeric result through `console.log`

This means the StarlingMonkey lane measures the runtime-eval component, not a
benchmark-specific compiled module.

## StarlingMonkey + ComponentizeJS (Wizer + Weval) lane

This lane gives the StarlingMonkey embedding the same kind of AOT story it
would have in production, instead of the generic runtime-eval flow. It is
distinct from the runtime-eval lane and is reported separately in the harness
output (label: `StarlingMonkey + ComponentizeJS (Wizer + Weval) -> Wasmtime`,
id: `starlingmonkey-componentize-wasmtime`).

### What runs in this lane

For each benchmark program the bundled adapter:

1. takes the program's pure-JS module
2. synthesizes a `<entry>-hot` loop export
3. emits a tiny WIT world containing both `<entry>` and `<entry>-hot`
4. feeds both into `@bytecodealliance/componentize-js`, which:
   - runs **Wizer** pre-initialization on the StarlingMonkey embedding so the
     resulting component already has the user module parsed and global init
     complete (always on)
   - runs **Weval** AOT specialization to partially evaluate the SpiderMonkey
     interpreter against the snapshotted module so hot calls bypass interpreter
     dispatch (on by default; opt out with `STARLINGMONKEY_COMPONENTIZE_AOT=0`)
5. writes the final `.wasm` component plus a `<output>.wasm.json` sidecar
   describing invoke export names and which post-processing passes ran

The harness then runs `wasmtime compile -O opt-level=2` and measures
cold-start, hot runtime, and module size like every other lane.

### Required tools

- `node` (>= 20, for `import.meta.resolve`)
- `pnpm` — to install `@bytecodealliance/componentize-js`
- `wasmtime` — to precompile and run the resulting component
- `wasm-opt` — required by the rest of the harness, not by this adapter
  specifically

`@bytecodealliance/componentize-js` ships its own `@bytecodealliance/wizer` and
`@bytecodealliance/weval` dependencies, so you do **not** need separate Wizer
or Weval installs. Weval downloads its native binary on first use; subsequent
runs are cached under `node_modules/.../weval/`.

### Minimal setup (auto-enabled)

```bash
pnpm install                # provisions @bytecodealliance/componentize-js
pnpm run benchmark:competitive
```

That's it: as of #1125 the harness auto-detects the bundled adapter at
`benchmarks/competitive/sm-componentize-adapter.mjs` whenever ComponentizeJS
is installed. The lane reports `ok` instead of `unavailable` provided
`wasmtime` is also installed.

To opt out of Weval AOT (Wizer-only):

```bash
STARLINGMONKEY_COMPONENTIZE_AOT=0 pnpm run benchmark:competitive
```

To force a custom adapter path:

```bash
export STARLINGMONKEY_ADAPTER=$PWD/benchmarks/competitive/sm-componentize-adapter.mjs
```

### Adapter contract

```bash
$STARLINGMONKEY_ADAPTER <input.js> <output.wasm>
```

The adapter writes:

- a benchmark-specific Wasm component to `<output.wasm>`
- a sidecar metadata file at `<output.wasm>.json` describing:
  - invoke export names (`invokeExport`, `hotInvokeExport`)
  - which post-processing passes ran (`wizerEnabled`, `wevalAotEnabled`)
  - the disabled WASI feature list

The benchmark harness reads that metadata automatically, so component exports
such as `run-hot` can be invoked correctly through Wasmtime.

### Adapter env vars

| Variable | Default | Purpose |
| --- | --- | --- |
| `STARLINGMONKEY_COMPONENTIZE_AOT` | `1` | Set to `0` to disable Weval AOT specialization. Wizer pre-init still runs. |
| `STARLINGMONKEY_WIZER_BIN` | (bundled) | Use an externally installed `wizer` instead of the one bundled with ComponentizeJS. |
| `STARLINGMONKEY_WEVAL_BIN` | (bundled) | Use an externally installed `weval` instead of the bundled one. |
| `STARLINGMONKEY_COMPONENTIZE_DISABLE_FEATURES` | `random,stdio,clocks,http,fetch-event` | Comma-separated list of WASI subsystems to strip from the embedding. |
| `STARLINGMONKEY_ENTRY_EXPORT` | `run` | Override the JS export the adapter should expose. The harness sets this. |
| `STARLINGMONKEY_HOT_EXPORT` | derived | Override the synthesized hot-loop export name. |
| `STARLINGMONKEY_COMPONENT_WORLD` | `benchmark` | Override the WIT world name. |
| `COMPONENTIZE_JS_BIN` | (none) | Force CLI fallback instead of the library import. |

### What is being measured vs the runtime-eval lane

| Aspect | runtime-eval | ComponentizeJS + Wizer + Weval |
| --- | --- | --- |
| StarlingMonkey embedding | unmodified `starling.wasm` | snapshotted with the benchmark module already loaded |
| Per-benchmark compile | none — JS source is read at runtime | a benchmark-specific component is built |
| Interpreter | full SpiderMonkey interpreter dispatch | Weval-specialized fast path for the snapshotted module |
| Cold start | full VM init + module parse + first call | precompiled component + first call only |
| Hot runtime | interpreter loop | partially-evaluated loop |
| Module size | constant (`starling.wasm`) | per-benchmark component (~12-15 MB after optimization) |

The two lanes are intentionally kept side-by-side so the harness can show the
delta between "drop a JS file into a generic JS host" and "build an optimized
component for this specific JS file".

### Caveats

- ComponentizeJS only accepts ESM input. The benchmark programs already export
  `run` as an ESM function, so this is satisfied.
- Weval downloads its native binary the first time AOT is enabled; the first
  run can therefore take longer and requires network access. Subsequent runs
  are cached under `node_modules`.
- Weval-specialized components are noticeably larger than Wizer-only ones
  (roughly +25%). The size delta is reported separately under `Raw bytes` and
  `Precompiled bytes`.
- The lane requires `wasmtime` on `PATH` (or `STARLINGMONKEY_WASMTIME_BIN`).
  Without it the lane reports `runtime-error`, not `unavailable`.
- The lane requires **wasmtime ≥ 40** because it relies on the v40
  component-model `--invoke "fn(args)"` parenthesized invoke syntax. On
  wasmtime 30 and 31 (verified) the CLI rejects `--invoke` against
  components and the lane reports `runtime-error`.

### A note on JIT and serverless Wasm

These benchmarks model a serverless Wasm runtime (Fastly Compute@Edge,
wasmCloud, etc.) where:

- **All Wasm code is precompiled at deploy time** via `wasmtime compile -O
  opt-level=2`, not JIT'd at request time. The harness uses the precompiled
  `.cwasm` for every Wasm lane to mirror this.
- **The guest cannot JIT either.** The Wasm sandbox model (W xor X pages)
  prevents code inside a Wasm module from generating new machine code at
  runtime, so SpiderMonkey running *inside* the StarlingMonkey embedding
  runs **interpreter-only** — its Baseline and Ion JIT tiers are
  unavailable in this deployment mode.

This is exactly the gap Wizer and Weval are designed to close:

| Optimization | What it does | When it runs |
| --- | --- | --- |
| Wizer pre-init | Snapshot the interpreter state with the user module already parsed and globals initialized | Deploy-time, pre-cold-start |
| Weval AOT specialization | Partially evaluate the SpiderMonkey interpreter against the snapshotted module so hot dispatch paths bypass the generic opcode-interpreter loop | Deploy-time |
| Wasmtime AOT (`wasmtime compile`) | Cranelift-compile the entire Wasm module to native machine code | Deploy-time |

The hot-runtime numbers in this README therefore reflect a
SpiderMonkey-in-Wasm-without-guest-JIT execution path, which is the same
shape users see in Fastly Compute@Edge today. They should not be compared
directly to running a benchmark in a JIT'd JS engine on a developer
workstation.

### Verified results — 2026-04-27 (wasmtime 44.0.0, aarch64-linux)

Five benchmark programs, three lanes that run in this environment (Node.js,
js2wasm, StarlingMonkey + ComponentizeJS). The runtime-eval lane is omitted
because it requires a vendored StarlingMonkey checkout that is not present
in this environment. AssemblyScript / Javy / Porffor are also omitted on
the same grounds.

#### Runtime metrics (median of 5–7 runs)

| Program | Lane | Cold ms | Hot ms | Compute-only ms |
| --- | --- | ---: | ---: | ---: |
| `array-sum` | Node.js | 22.4 | 15.3 | 12.9 |
| `array-sum` | js2wasm → Wasmtime | _runtime-error: WebAssembly translation error_ | | |
| `array-sum` | SM + Componentize (Wizer + Weval) → Wasmtime | 29.4 | 159.2 | 125.9 |
| `fib-recursive` | Node.js | 18.1 | 10.4 | 4.7 |
| `fib-recursive` | js2wasm → Wasmtime | **28.2** | **10.1** | **2.9** |
| `fib-recursive` | SM + Componentize (Wizer + Weval) → Wasmtime | 33.7 | 191.7 | 155.6 |
| `fib` | Node.js | 27.1 | 16.6 | 10.7 |
| `fib` | js2wasm → Wasmtime | **27.0** | **18.8** | **10.5** |
| `fib` | SM + Componentize (Wizer + Weval) → Wasmtime | 30.0 | 1111.2 | 923.1 |
| `object-ops` | Node.js | 29.5 | 5.2 | 1.1 |
| `object-ops` | js2wasm → Wasmtime | _runtime-error: failed to parse WebAssembly module_ | | |
| `object-ops` | SM + Componentize (Wizer + Weval) → Wasmtime | 34.3 | 226.7 | 182.4 |
| `string-hash` | Node.js | 20.7 | 5.4 | 0.9 |
| `string-hash` | js2wasm → Wasmtime | _compile-error: wasm-validator (pre-existing js2wasm bug)_ | | |
| `string-hash` | SM + Componentize (Wizer + Weval) → Wasmtime | 28.2 | 20.5 | 11.9 |

For the two programs where js2wasm → Wasmtime succeeds end-to-end
(`fib-recursive`, `fib`), js2wasm beats SpiderMonkey + ComponentizeJS on hot
runtime by **~19× to ~60×**:

- `fib`: js2wasm 18.8 ms vs SM 1,111.2 ms → **59× faster**
- `fib-recursive`: js2wasm 10.1 ms vs SM 191.7 ms → **19× faster**

The size story is the second headline finding: SM + ComponentizeJS is
**~50,000× larger** than the equivalent js2wasm precompiled artifact (52 MB
vs 193 kB cwasm) because the component carries a snapshotted SpiderMonkey
embedding plus the user module. js2wasm compiles the user module directly
to Wasm without an embedded interpreter.

The other three programs hit pre-existing js2wasm codegen bugs unrelated to
`#1125`. The SM + ComponentizeJS lane successfully runs all five.

#### A/B verification: Wizer-only vs Wizer + Weval AOT

Empirical proof both Wizer and Weval are actually running (not just
claimed by the metadata sidecar). Same `fib` benchmark, same wasmtime 44,
adapter run twice with the only difference being `STARLINGMONKEY_COMPONENTIZE_AOT`:

| Setting | Adapter compile time | Component size |
| --- | ---: | ---: |
| `STARLINGMONKEY_COMPONENTIZE_AOT=0` (Wizer only) | 1,607 ms | 11,940,229 bytes |
| `STARLINGMONKEY_COMPONENTIZE_AOT=1` (Wizer + Weval, default) | 3,811 ms | 14,815,040 bytes |
| **Delta** | **+2,204 ms (+137 %)** | **+2,874,811 bytes (+24 %)** |

The +24 % size delta matches this README's documented ~25 % expectation
exactly, and the +137 % compile-time delta accounts for Weval's downloaded
native binary running as a post-processing step over the Wizer-snapshotted
component.

The hot-runtime delta between Wizer-only and Wizer + Weval is workload-
dependent. For `fib` (a tight `for` over integer arithmetic) the inner loop
runs the same handful of opcodes 20 million times, so Weval's interpreter-
dispatch specialization has very little overhead to amortize away — the
two configurations come out within run-to-run noise on this workload.
Weval is designed to pay off on workloads dominated by property access,
dynamic dispatch, or many distinct call sites; the bundled `fib` program
is a deliberately degenerate case from that perspective.

#### Size metrics (per benchmark program)

| Program | js2wasm raw | js2wasm gz | js2wasm cwasm | SM + Comp raw | SM + Comp gz | SM + Comp cwasm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `fib` | 0.1 kB | 0.1 kB | 193.5 kB | 14,467.8 kB | 4,316.5 kB | 53,437.3 kB |
| `fib-recursive` | 0.2 kB | 0.1 kB | 193.6 kB | 14,470.0 kB | 4,317.0 kB | 53,437.4 kB |
| `array-sum` | 0.5 kB | 0.3 kB | _n/a_ | 14,469.2 kB | 4,316.8 kB | 53,437.3 kB |
| `object-ops` | 0.5 kB | 0.3 kB | 194.5 kB | 14,469.4 kB | 4,317.1 kB | 53,437.3 kB |
| `string-hash` | 4.5 kB | 1.9 kB | _n/a_ | 14,473.3 kB | 4,318.3 kB | 53,501.3 kB |

## Javy

For each benchmark program, the harness generates a wrapper script that:

- inlines the benchmark program source
- reads `{ input, iterations }` as JSON from stdin through `Javy.IO`
- executes `run(input)` once or in a hot loop
- writes the numeric result to stdout

The Javy lane currently uses the default static runtime build, so its module
size includes the bundled QuickJS runtime.

## AssemblyScript

This lane is not source-identical JavaScript. The harness translates each
benchmark kernel into a small typed AssemblyScript equivalent and compiles it
with:

- `-O3 --converge --runtime stub --noAssert`
- followed by `wasm-opt -O4`

## Porffor

Porffor's raw wasm output is not a drop-in WASI/Wasmtime target, so the harness
measures Porffor through its own module compiler/runtime path in Node.js:

- cold start: fresh process compile + instantiate + first call
- hot runtime: fresh process with one compile/instantiate and repeated calls
- compute-only: internal timed repeated calls after warm-up

For size reporting, the harness still emits Porffor's wasm output with:

- `--module -O3`
- followed by `wasm-opt -O4`
