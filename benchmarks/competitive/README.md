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
because the embedded SpiderMonkey engine uses Wasm exception-handling
bytecode for its exception machinery. (Throughout this README,
"StarlingMonkey" refers to the Bytecode Alliance's SpiderMonkey embedding
— the project that wraps Mozilla's SpiderMonkey JavaScript engine for
WASI / Component Model targets. When we discuss the snapshotted runtime,
the WIT bindings, or the deployed Wasm component, that is StarlingMonkey;
when we discuss the interpreter loop, the parser, or the GC, those are
SpiderMonkey internals that StarlingMonkey embeds.)
`gc-support=y` (a pre-v31 flag) was collapsed into `gc=y` upstream and is
no longer set by the harness.

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
# Javy (Shopify Functions production setup — dynamic mode by default)
# Download the latest Javy CLI + plugin.wasm from
#   https://github.com/bytecodealliance/javy/releases/latest
# and set:
export JAVY_BIN=/absolute/path/to/javy
export JAVY_PLUGIN=/absolute/path/to/plugin.wasm
# Set JAVY_DYNAMIC=0 to fall back to legacy static (self-contained) Javy
# builds. Default is dynamic if a plugin is reachable — that matches
# Shopify Functions, which ships per-function modules of ~1 kB plus a
# shared 1.2 MB plugin.wasm at the host level. Static mode produces
# ~1.2 MB self-contained Wasm per function.
export JAVY_DYNAMIC=1

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
- **The guest does not JIT either.** The Wasm sandbox model (W xor X
  pages) means code inside a Wasm module does not generate new machine
  code at runtime, so JS engines running inside Wasm operate as
  interpreter-only in this deployment shape. For StarlingMonkey, that
  means SpiderMonkey's Baseline and Ion JIT tiers are not active; for
  Javy, the same applies to QuickJS. Both projects address this through
  deliberate design choices that are explicitly oriented around an
  interpreter-only execution model — Wizer + Weval AOT specialization
  in StarlingMonkey's case, dynamic-link Wasm bytecode-emission in
  Javy's case.

This is exactly the gap Wizer and Weval are designed to close:

| Optimization | What it does | When it runs |
| --- | --- | --- |
| Wizer pre-init | Snapshot the interpreter state with the user module already parsed and globals initialized | Deploy-time, pre-cold-start |
| Weval AOT specialization | Partially evaluate the embedded interpreter (SpiderMonkey, inside StarlingMonkey) against the snapshotted module so hot dispatch paths bypass the generic opcode-interpreter loop | Deploy-time |
| Wasmtime AOT (`wasmtime compile`) | Cranelift-compile the entire Wasm module to native machine code | Deploy-time |
| Javy dynamic linking | Compile the user JS to a small Wasm that imports QuickJS from a shared `plugin.wasm` (Shopify Functions production setup) | Deploy-time |

The hot-runtime numbers in this README therefore reflect a
JS-interpreter-on-Wasm-without-guest-JIT execution path (whether the
interpreter is StarlingMonkey's SpiderMonkey or Javy's QuickJS), which is
the same shape users see in Fastly Compute@Edge or Shopify Functions
today. They should not be compared directly to running a benchmark in a
JIT'd JS engine on a developer workstation.

### Verified results — 2026-04-27 (wasmtime 44.0.0, aarch64-linux)

Five benchmark programs, four lanes that run in this environment (Node.js,
js2wasm, Javy in Shopify Functions production mode, and StarlingMonkey +
ComponentizeJS with Wizer + Weval). The StarlingMonkey runtime-eval lane
is omitted because it requires a vendored StarlingMonkey checkout that is
not present in this environment. AssemblyScript / Porffor are also omitted
on the same grounds.

#### Runtime metrics (median of 5–7 runs)

| Program | Lane | Cold ms | Hot ms | Compute-only ms |
| --- | --- | ---: | ---: | ---: |
| `array-sum` | Node.js | 28.3 | 21.2 | 11.4 |
| `array-sum` | js2wasm → Wasmtime | _runtime-error: WebAssembly translation error_ | | |
| `array-sum` | Javy (Shopify dynamic) → Wasmtime | 28.0 | 144.1 | 112.9 |
| `array-sum` | StarlingMonkey + Componentize (Wizer + Weval) → Wasmtime | 31.0 | 156.2 | 125.5 |
| `fib-recursive` | Node.js | 19.2 | 10.2 | 4.9 |
| `fib-recursive` | js2wasm → Wasmtime | **32.5** | **11.3** | **3.5** |
| `fib-recursive` | Javy (Shopify dynamic) → Wasmtime | 31.2 | 114.0 | 87.9 |
| `fib-recursive` | StarlingMonkey + Componentize (Wizer + Weval) → Wasmtime | 26.4 | 195.3 | 156.7 |
| `fib` | Node.js | 19.1 | 16.9 | 10.8 |
| `fib` | js2wasm → Wasmtime | **26.2** | **18.3** | **11.9** |
| `fib` | Javy (Shopify dynamic) → Wasmtime | 28.8 | 1453.2 | 1193.2 |
| `fib` | StarlingMonkey + Componentize (Wizer + Weval) → Wasmtime | 37.2 | 1241.8 | 1024.3 |
| `object-ops` | Node.js | 24.0 | 6.5 | 0.7 |
| `object-ops` | js2wasm → Wasmtime | _runtime-error: failed to parse WebAssembly module_ | | |
| `object-ops` | Javy (Shopify dynamic) → Wasmtime | 24.6 | 246.8 | 207.7 |
| `object-ops` | StarlingMonkey + Componentize (Wizer + Weval) → Wasmtime | 37.5 | 243.3 | 199.0 |
| `string-hash` | Node.js | 29.9 | 9.4 | 1.8 |
| `string-hash` | js2wasm → Wasmtime | _compile-error: wasm-validator (pre-existing js2wasm bug)_ | | |
| `string-hash` | Javy (Shopify dynamic) → Wasmtime | 30.7 | 48.8 | 36.0 |
| `string-hash` | StarlingMonkey + Componentize (Wizer + Weval) → Wasmtime | 30.5 | 22.2 | 14.2 |

For the two programs where js2wasm → Wasmtime succeeds end-to-end
(`fib-recursive`, `fib`), js2wasm has a hot-runtime advantage over both
JS-host approaches of an order of magnitude or more on these workloads:

- `fib`: js2wasm 18.3 ms; Javy 1,453.2 ms (~79× slower for this workload); StarlingMonkey 1,241.8 ms (~68× slower for this workload).
- `fib-recursive`: js2wasm 11.3 ms; Javy 114.0 ms (~10× slower for this workload); StarlingMonkey 195.3 ms (~17× slower for this workload).

This is the expected shape: js2wasm executes as compiled Wasm directly,
while Javy and StarlingMonkey both run a JS interpreter inside Wasm
(see "A note on JIT and serverless Wasm" above for why the guest
interpreter is the relevant comparison point in this deployment model).
The gap is workload-dependent — for very tight numeric loops the
interpreter's per-opcode dispatch cost compounds, while for workloads
with more diverse opcode mixes (such as `string-hash` below) the gap
narrows considerably.

Where Javy and StarlingMonkey overlap (all five programs):

- For `array-sum`, `fib-recursive`, and `object-ops`, the two come out
  roughly equivalent on hot runtime.
- For `fib` (tight numeric loop), StarlingMonkey is ~17 % faster than
  Javy (1,242 ms vs 1,453 ms).
- For `string-hash`, StarlingMonkey is ~2.2× faster than Javy (22.2 ms
  vs 48.8 ms), where Weval AOT specialization meaningfully amortizes
  interpreter-dispatch overhead on a workload with more dispatch variety.

The other three programs hit pre-existing js2wasm codegen bugs unrelated
to `#1125` (filed as #1173, #1174, #1175). Both the Javy and
StarlingMonkey + ComponentizeJS lanes successfully run all five programs
end-to-end on the test set.

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

Per-function module sizes (the part that ships per JS function deployed):

| Program | js2wasm raw | js2wasm cwasm | Javy raw | Javy cwasm | StarlingMonkey + Comp raw | StarlingMonkey + Comp cwasm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `fib` | 0.1 kB | 193.5 kB | 2.8 kB | 195.6 kB | 14,467.8 kB | 53,437.3 kB |
| `fib-recursive` | 0.2 kB | 193.6 kB | 2.7 kB | 195.6 kB | 14,470.0 kB | 53,437.4 kB |
| `array-sum` | 0.5 kB | _n/a_ | 3.0 kB | 195.8 kB | 14,469.2 kB | 53,437.3 kB |
| `object-ops` | 0.5 kB | 194.5 kB | 3.0 kB | 195.8 kB | 14,469.4 kB | 53,437.3 kB |
| `string-hash` | 4.5 kB | _n/a_ | 3.4 kB | 196.1 kB | 14,473.3 kB | 53,501.3 kB |

Shared / per-host runtime cost (deployed once across every function):

| Lane | Shared runtime | Notes |
| --- | ---: | --- |
| js2wasm | _none_ | the user module is the entire artifact |
| Javy (dynamic, Shopify-style) | 1,212.4 kB plugin.wasm | shared QuickJS runtime imported via `--preload javy-default-plugin-v3=plugin.wasm` |
| StarlingMonkey + ComponentizeJS | _bundled per function in `componentize-js` 0.20.0_ | the SpiderMonkey embedding is included in each component today; a shared-runtime / library-component direction is on the Bytecode Alliance roadmap |

**Total deployment size for N functions** depends on which bytes you account
for. Both views below are valid; each models a different stage of the
deployment pipeline:

**View A — raw `.wasm` bytes** (the artifact you upload, version-control, or
push to a registry):

| N | js2wasm | Javy (dynamic) | StarlingMonkey + ComponentizeJS |
| ---: | ---: | ---: | ---: |
| 1 | ~0.5 kB | ~1,215 kB (1,212 kB plugin + 3 kB user) | ~14,500 kB |
| 100 | ~50 kB | ~1.5 MB (1,212 kB plugin + 300 kB users) | ~1.45 GB |
| 10,000 | ~5 MB | ~31 MB (1,212 kB plugin + 30 MB users) | ~145 GB |

**View B — precompiled `.cwasm` bytes** (what wasmtime actually loads when you
deploy with `wasmtime compile -O opt-level=2` first, as Fastly Compute@Edge
does in production):

| N | js2wasm | Javy (dynamic) | StarlingMonkey + ComponentizeJS |
| ---: | ---: | ---: | ---: |
| 1 | ~194 kB | ~5.07 MB (4,870 kB plugin + 196 kB user) | ~53.4 MB |
| 100 | ~19.4 MB | ~24.5 MB (4.87 MB plugin + 19.6 MB users) | ~5.34 GB |
| 10,000 | ~1.94 GB | ~1.96 GB (4.87 MB plugin + 1.96 GB users) | ~534 GB |

The two views diverge because Cranelift's AOT output carries a roughly fixed
~190 kB of per-module wasmtime-runtime metadata (type tables, instantiation
data, native code prelude) regardless of how small the input `.wasm` is. So a
~0.1 kB js2wasm user module and a ~3 kB Javy user module both land at
~196 kB once Cranelift is done with them. At the cwasm level, that fixed
overhead dominates and the per-function `.cwasm` sizes for js2wasm and Javy
become essentially equivalent.

### What this means for each toolchain's design

Each project optimizes for a different shape, and the numbers reflect those
deliberate engineering choices:

- **js2wasm** compiles the user's TypeScript directly to Wasm at build time.
  The user-facing `.wasm` is small because nothing else ships alongside it,
  and the `.cwasm` is dominated by Cranelift's per-module metadata —
  the same fixed overhead any small Wasm module pays.
- **Javy** in Shopify Functions production setup ships QuickJS as a shared
  `plugin.wasm` deployed once per host, with each function carrying just its
  own ~1–3 kB compiled bytecode. This is a deliberate amortization design:
  the more functions a host runs, the lower the marginal cost per function.
  At 10,000 functions, Javy's total cwasm footprint converges with js2wasm
  (~1.96 GB vs ~1.94 GB) because the Cranelift per-module overhead equalizes
  the two once both are precompiled.
- **StarlingMonkey + ComponentizeJS** at `componentize-js` 0.20.0 includes
  the SpiderMonkey embedding in every component. This is a self-contained
  deployable-unit design — each artifact is independently runnable without
  needing a sibling runtime, which simplifies some deployment models.
  Bytecode Alliance roadmap work on shared-runtime / library-component
  composition is what would amortize the embedding across functions in
  the same way Javy does today.

### Where each design has the deployment-size advantage

- For **uploaded source artifacts (View A)**, js2wasm produces the smallest
  per-function module, and Javy's dynamic-link design produces the
  smallest *marginal* per-function module once the shared plugin is in place.
  Both architectures avoid bundling a JS engine per function.
- For **loaded cwasm at request time (View B)**, js2wasm and Javy are nearly
  equivalent at scale; the Cranelift per-module overhead dominates once the
  user module is precompiled.
- For **all views today**, StarlingMonkey + ComponentizeJS has a per-function
  size gap that reflects its current self-contained-component design — a
  trade-off the Bytecode Alliance is actively addressing with shared-runtime
  work referenced earlier in this README.

### Deployment savings analysis

This section translates the size and runtime numbers above into operational
savings on real serverless platforms. The arithmetic is parameterised on
"$X per CPU-second" so the reader can plug in current rates from the
provider's pricing page rather than relying on figures that may go stale.

#### 1. Storage savings (derived from the size tables above)

For 10,000 deployed functions, choosing js2wasm or Javy over StarlingMonkey
+ ComponentizeJS saves on the order of:

| Switching from → to | Storage saved (cwasm view) | Storage saved (raw view) |
| --- | ---: | ---: |
| StarlingMonkey + ComponentizeJS → Javy (Shopify dynamic) | ~532 GB | ~145 GB |
| StarlingMonkey + ComponentizeJS → js2wasm | ~532 GB | ~145 GB |
| Javy (Shopify dynamic) → js2wasm | ~20 MB | ~26 MB |

js2wasm and Javy are essentially tied on cwasm storage at scale — both
benefit from a small per-function payload, and Javy's shared plugin
amortizes its QuickJS runtime across all functions.

#### 2. Cumulative execution-time savings (worked example)

For a workload like `fib(20,000,000)` invoked 1,000,000 times per month
(a realistic monthly invocation count for a popular serverless function):

| Lane | Per-call hot | × 1M invocations | Wall-clock CPU |
| --- | ---: | ---: | --- |
| js2wasm → Wasmtime | 18.3 ms | 18,300 s | ~5.1 hours |
| Javy (Shopify dynamic) → Wasmtime | 1,453.2 ms | 1,453,200 s | **~16.8 days** |
| StarlingMonkey + ComponentizeJS → Wasmtime | 1,241.8 ms | 1,241,800 s | **~14.4 days** |

| Switching from → to | CPU time saved per month | Saved per year |
| --- | ---: | ---: |
| Javy → js2wasm | ~16.6 days | ~199 days |
| StarlingMonkey + ComponentizeJS → js2wasm | ~14.3 days | ~172 days |
| StarlingMonkey + ComponentizeJS → Javy | ~2.4 days | ~29 days |

These figures are linear in invocation count and proportional to the
hot-runtime delta, so they scale predictably to other workloads — the
table above can be re-derived for any (workload, monthly invocations)
pair using the per-call hot numbers from the runtime table.

#### 3. Cost translation — Fastly Compute@Edge

Fastly Compute@Edge is billed on a per-request and compute-time basis;
current pricing is published at
[fastly.com/pricing](https://www.fastly.com/pricing) and varies by tier.
The framework below is parameterised so the reader can plug in the
current rate.

**Formula:**

```
$ saved per function per month
   = (other_lane_ms − js2wasm_ms) × monthly_invocations × ($/CPU-sec ÷ 1000)
```

**Worked example** (illustrative, *not* a quotation — verify the current
rate at fastly.com/pricing): for a 1M monthly-invocation workload at an
illustrative rate of `$0.00005 / CPU-second`:

| Switching from → to | Saved per function / month | × 100 functions | × 10,000 functions |
| --- | ---: | ---: | ---: |
| Javy → js2wasm (`fib`, Δ = 1,434.9 ms/call) | ~$71.75 | ~$7,175 | ~$717,500 |
| StarlingMonkey → js2wasm (`fib`, Δ = 1,223.5 ms/call) | ~$61.18 | ~$6,118 | ~$611,800 |
| StarlingMonkey → Javy (`fib`, Δ = 211.4 ms/call) | ~$10.57 | ~$1,057 | ~$105,700 |

For non-numeric workloads with smaller hot-runtime deltas (e.g.
`string-hash` where StarlingMonkey already amortizes the interpreter
through Weval AOT), the per-call savings shrink correspondingly.
The delta-per-call is the operative quantity; the savings table above
re-derives directly from the runtime metrics for any program.

The illustrative rate (`$0.00005 / CPU-second`) is a placeholder in the
ballpark of typical compute-tier pricing — actual savings should be
calculated using each customer's contracted Fastly rate. Fastly bundles
some compute-time allowance into the per-request price on certain plans,
so the effective marginal $/CPU-sec varies with the customer's request
volume and tier.

#### 4. Cost translation — Shopify Functions

Shopify Functions uses a different billing model. The platform absorbs
the compute cost — there is no direct per-invocation $ charge to the app
developer or merchant — but Shopify enforces hard limits that translate
"savings" into something different from a dollar figure:

| Limit | Current value | What it means in practice |
| --- | --- | --- |
| Execution time per call | 5 ms wall-clock | Functions that exceed are killed; merchant flow breaks |
| Module size | 256 kB compressed | Larger Wasm cannot be uploaded at all |
| Memory | 10 MB per instance | Hard cap on linear memory + JS heap |

Refer to the official Shopify Functions documentation for current limit
values, since they evolve over time.

For our `fib(20,000,000)` workload, **all three lanes exceed 5 ms**
substantially (js2wasm 18.3 ms, Javy 1,453 ms, StarlingMonkey 1,242 ms),
which simply puts that workload outside Shopify Functions' design space.
For lighter workloads more typical of Shopify Functions (cart validation,
shipping rate computation, discount logic):

- **js2wasm** has the most headroom under the 5 ms budget: more JS
  complexity stays within the budget before timing out.
- **Javy (dynamic)** fits Shopify's 256 kB module-size limit by design —
  the user-specific Wasm is ~3 kB and the QuickJS runtime ships once at
  the platform layer. Javy is the toolchain Shopify Functions actively
  supports today.
- **StarlingMonkey + ComponentizeJS** at `componentize-js` 0.20.0
  produces ~14.5 MB components, which exceed Shopify Functions' 256 kB
  module-size limit by ~57×. The Bytecode Alliance shared-runtime /
  library-component direction (referenced earlier in this README) is
  what would unlock fitting under such a limit.

For Shopify Functions specifically, the relevant "savings" question is
not "how many dollars" but "what additional logic can fit within the
5 ms / 256 kB / 10 MB envelope" — and the answer there favors faster
execution per call for any toolchain that targets the platform.

#### Caveats for these projections

- **Workload-specific extrapolation.** The savings tables use the `fib`
  hot-runtime numbers as a worked example. Different workloads have
  different per-call hot deltas; the formula remains correct but plug in
  the relevant program's number from the runtime table.
- **Single-call hot vs warmed-loop hot.** The hot-runtime metric is
  measured by looping inside one fresh process after one warm-up call;
  this is closest to "function is hot, requests stream in steadily".
  Cold-start-dominated traffic patterns shift the savings story — check
  the cold-start column too.
- **CPU pricing is platform-specific.** The Fastly worked example uses
  an illustrative rate. Customer contracts, tier bundling, and request-
  volume discounts all change the marginal $/CPU-sec. The formula above
  composes with whatever rate the customer actually pays.
- **Memory translation is a separate axis.** This section discusses CPU
  time and storage. Runtime memory (peak RSS while a function instance
  is live) is not currently captured by the harness; cwasm size is a
  *floor* but not the full picture. See "future work" notes for the
  follow-up that would add real RSS instrumentation.

## Javy

For each benchmark program, the harness generates a wrapper script that:

- inlines the benchmark program source
- reads `{ input, iterations }` as JSON from stdin through `Javy.IO`
- executes `run(input)` once or in a hot loop
- writes the numeric result to stdout

### Build mode: dynamic (Shopify Functions production setup, default)

Javy's `--codegen dynamic=y --codegen plugin=…` mode produces a small Wasm
that imports QuickJS from a shared `plugin.wasm`. This is the same setup
Shopify Functions uses in production: every function deploys as ~1–3 kB
of user-specific Wasm (just compiled QuickJS bytecode + JS source), and
the QuickJS runtime is shipped once at the host level as a 1.2 MB plugin.

The harness invokes wasmtime with
`--preload javy-default-plugin-v3=<plugin.cwasm>` so the dynamic user
module can resolve QuickJS imports. Both the user module and the plugin
are precompiled with `wasmtime compile -O opt-level=2`; in production
Shopify caches the plugin precompile across all function deploys.

### Build mode: static (legacy fallback)

Setting `JAVY_DYNAMIC=0`, or running without a plugin available, falls
back to Javy's static build: `javy build -J javy-stream-io=y -J
text-encoding=y …`. This bundles QuickJS into every per-function Wasm
module (~1.2 MB each). It's simpler to deploy (single artifact per
function) but loses the per-function size advantage that motivated the
dynamic mode in the first place.

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
