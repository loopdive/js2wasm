# js2wasm

Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC.

`js2wasm` compiles source code into WasmGC binaries without embedding a JavaScript interpreter or shipping a bundled runtime. That removes the runtime tax common in interpreter-in-Wasm and bundled-engine stacks, where interpreters often land in the high-hundreds-of-kilobytes range and full-fledged JavaScript engines in the megabytes, and keeps the output aligned with Wasm-native deployment models.

`js2wasm` is the core compiler product of **Loopdive GmbH**, released under **Apache License 2.0 with LLVM Exceptions**. The repository contains the public compiler source, examples, tests, benchmarks, and documentation needed to review and use the project.

## Value Proposition

Most JavaScript-on-Wasm systems work by putting a JavaScript engine inside a Wasm module. That approach inherits good compatibility, but it also inherits the cost of shipping and initializing the engine.

`js2wasm` takes the opposite approach:

- **Direct AOT compilation to WasmGC** instead of interpreter bundling
- **No embedded JS engine** in the deployed module
- **No bundled interpreter or engine tax** just to execute application code
- **Wasm-native deployment model** for runtimes, serverless platforms, and embedded hosts

This matters for infrastructure workloads where artifact size, cold start, density, and host integration are first-order constraints.

It also matters for security boundaries. In browsers, Node.js, and other JavaScript-capable hosts, compiling modules to Wasm introduces an isolation boundary that can limit how much third-party dependencies and user-provided code can affect the surrounding process. That is relevant for supply-chain defense, plugin systems, and multi-tenant execution.

## Why This Architecture

`js2wasm` is being built for environments where bundling a JavaScript engine is the wrong tradeoff:

- edge and serverless runtimes
- Wasm-first infrastructure platforms
- plugin and extension systems
- embedders that want JavaScript semantics without shipping an interpreter
- desktop applications that want a lighter and safer alternative to Electron-style runtime bundling

That includes practical combinations with hosts like Tauri, where compiler output can be shipped as executable Wasm artifacts instead of bundling a full browser-plus-JS-engine runtime into the application.

The current public benchmark and conformance work is aimed at proving that direct compilation can become a viable alternative to interpreter bundling for production infrastructure.

Many alternatives in adjacent spaces solve the problem by narrowing the language instead:

- supporting only a constrained subset of TypeScript or JavaScript
- introducing a new language or dialect that compiles to Wasm more easily

`js2wasm` is aimed at a harder target: targeting mainstream JavaScript semantics through direct compilation rather than changing the language model to fit the compiler.

Projects in this category usually take years to reach meaningful semantic coverage. A large part of the Loopdive thesis is that an AI-native compiler workflow can compress that timeline substantially without giving up on the harder target.

Current public milestone:

- **~60% Test262 compliance**

See the [Playground](https://loopdive.github.io/js2wasm/playground/) and [Roadmap](./ROADMAP.md) for the current public surface.

## Current Status

`js2wasm` is still an active compiler effort, but it is no longer just a research prototype. The project now has:

- **~60% Test262 compliance**
- a public browser playground
- ongoing benchmark and compatibility reporting
- both JS-hosted and standalone-oriented compiler work, with standalone support still in progress and not yet the primary conformance path

The project is being positioned for a community-first release while the compiler, runtime boundary, and conformance story continue to harden.

## How It Compares

Most JavaScript-on-Wasm approaches fit into one of four broad categories:

1. bundled JavaScript interpreters,
2. bundled JavaScript engines,
3. incompatible JavaScript or TypeScript subsets, supersets, and new languages,
4. direct AOT compilation of JavaScript semantics to WasmGC.

`js2wasm` is in the fourth category.

Bundled-runtime approaches inherit compatibility from an interpreter or engine,
but every deployed module pays for that runtime. Subset, superset, and
new-language approaches can generate compact Wasm by changing the language
contract.

`js2wasm` is aimed at a different target: **JavaScript semantics without
shipping a JavaScript engine or interpreter inside the deployed artifact**.
Where the compiler can prove stable types and shapes, it lowers them directly to
WasmGC structs, arrays, primitives, and functions. Where JavaScript remains
dynamic, it inserts guards, uses dynamic representations, or delegates at host
boundaries.

For a more detailed category-level comparison, see the [FAQ](./docs/faq.md).

## Quick Start

Install dependencies:

```bash
pnpm install
```

Compile a file:

```bash
npx js2wasm input.ts -o output.wasm
```

Programmatic API:

```ts
import { compile } from "js2wasm";

const result = compile(`
  export function add(a: number, b: number): number {
    return a + b;
  }
`);

if (result.success) {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  console.log((instance.exports as any).add(2, 3));
}
```

Useful local commands:

```bash
pnpm typecheck
pnpm lint
npm test
pnpm run test:262
pnpm dev
```

## What Works Today

The compiler already covers a meaningful subset of the language and runtime surface. Current work is concentrated on steadily expanding spec coverage while reducing dependence on JS-host fallbacks.

Areas with meaningful progress today include:

- arithmetic and basic scalar operations
- functions, closures, and many control-flow forms
- classes, inheritance, and object operations
- arrays, strings, destructuring, and template literals
- significant portions of built-in and host interop behavior
- a public conformance workflow based on Test262

This is not yet a “drop in any npm package” story. It is a serious compiler with a growing compatibility baseline and a clear infrastructure target.

## Licensing

This repository is licensed under the **Apache License 2.0 with LLVM Exceptions**. See [LICENSE](./LICENSE).

### Community License

- Source code in this repository is available under **Apache-2.0 WITH LLVM-exception**
- Community contributions are accepted under the contributor terms described in [CONTRIBUTING.md](./CONTRIBUTING.md)

### Commercial Licensing

Loopdive GmbH offers commercial licensing discussions for infrastructure partners that need:

- proprietary integrations
- closed-source redistribution rights
- dedicated support or integration work
- custom backends or hardware-accelerated targets
- private deployment arrangements for platform partnerships

This is the intended path for infrastructure vendors and strategic partners, including cloud, edge, browser, and silicon platform organizations evaluating deeper integration.

Contact: `hello@loopdive.com`

## Testing

`js2wasm` validates correctness through three complementary test layers:

- **Unit & equivalence tests** — `npm test` (vitest). Targeted regression coverage and JS↔Wasm equivalence assertions. See `tests/equivalence/`.
- **Test262 conformance** — `pnpm run test:262` runs the official ECMAScript test suite (~48k tests) and reports per-edition / per-path pass rates. CI runs this sharded on every PR; the [report](./benchmarks/results/report.html) is regenerated on each merge.
- **Differential testing vs V8** — `pnpm run test:diff` (#1203). For each program in `tests/differential/corpus/`, the harness runs Node-V8 directly and the compiled `.wasm` and compares stdout. test262 measures spec compliance; differential testing measures whether real programs actually produce the right answer. CI gates each PR on a delta against `benchmarks/results/diff-test-baseline.json` — no new mismatches allowed. Use `pnpm run test:diff:triage` to bucket mismatches by category for follow-up filing.

## Development

Additional contributor workflow details, including CLA terms, are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Architecture decisions

The foundational design choices behind `js2wasm` — why WasmGC instead of linear memory, why AOT instead of an embedded engine, how TypeScript annotations are treated, how closures are lowered — are documented as Architecture Decision Records in [`docs/adr/`](./docs/adr/README.md). Each record states the context, the decision, and the consequences in 200–600 words. Start with [ADR-002 (architectural approach)](./docs/adr/0002-architectural-approach.md) and [ADR-001 (hybrid compilation strategy)](./docs/adr/0001-hybrid-compilation-strategy.md); the rest are sub-decisions within that frame.

## Further Reading

- [Playground](https://loopdive.github.io/js2wasm/playground/)
- [Roadmap](./ROADMAP.md)
- [Architecture Decisions](./docs/adr/README.md)
- [Contributing](./CONTRIBUTING.md)

## Acknowledgments

We are grateful to the following people for fruitful technical discussions that shaped key design decisions in this project:

- **Chris Fallin** (Cranelift tech lead) — discussions on type inference, IR design, and the performance implications of missing type information at object boundaries.
- **Luke Wagner** (WebAssembly co-designer, Mozilla / Fastly) — discussions on WasmGC type system design, component model integration, and the long-term direction of WasmGC as a compilation target for typed languages.

## Trademark Disclaimer

JavaScript is a trademark or registered trademark of Oracle in the United States and other countries. This project is independent from Oracle and is not endorsed by, sponsored by, or affiliated with Oracle.
