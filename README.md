# js2wasm

Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC.

`js2wasm` compiles source code into WasmGC binaries without embedding a JavaScript interpreter or shipping a bundled runtime. That removes the multi-megabyte runtime tax common in interpreter-in-Wasm stacks and keeps the output aligned with Wasm-native deployment models.

`js2wasm` is the core compiler product of **Loopdive GmbH** and is being prepared for a community-first launch under **GNU AGPL v3**.

## Value Proposition

Most JavaScript-on-Wasm systems work by putting a JavaScript engine inside a Wasm module. That approach inherits good compatibility, but it also inherits the cost of shipping and initializing the engine.

`js2wasm` takes the opposite approach:

- **Direct AOT compilation to WasmGC** instead of interpreter bundling
- **No embedded JS engine** in the deployed module
- **No 5 MB runtime tax** just to execute application code
- **Wasm-native deployment model** for runtimes, serverless platforms, and embedded hosts

This matters for infrastructure workloads where artifact size, cold start, density, and host integration are first-order constraints.

## Why This Architecture

`js2wasm` is being built for environments where bundling a JavaScript engine is the wrong tradeoff:

- edge and serverless runtimes
- Wasm-first infrastructure platforms
- plugin and extension systems
- embedders that want JavaScript semantics without shipping an interpreter

The current public benchmark and conformance work is aimed at proving that direct compilation can become a viable alternative to interpreter bundling for production infrastructure.

Current public milestone:

- **52% Test262 compliance**

See the [Playground](https://loopdive.github.io/js2wasm/playground/) and [Roadmap](./ROADMAP.md) for the current public surface.

## The Methodology

Loopdive develops `js2wasm` with an **Automated Agile Team** model. The goal is not novelty for its own sake. The goal is to compress the feedback loop between product intent, compiler implementation, and conformance verification.

### Operating Roles

- **Product Owner**: defines goals with the human stakeholder, plans sprints, prioritizes work, and keeps the backlog aligned with the product surface.
- **Technical Delivery Lead**: orchestrates sprint execution, coordinates task flow, manages merge discipline, and keeps implementation work moving through the pipeline.
- **Compiler Engineer (AI)**: implements ECMA-262 behavior, compiler pipeline changes, WasmGC lowering, and code generation details.
- **QA Engineer (Automated)**: runs CI-based conformance and regression feedback loops, especially around Test262 trend tracking and behavioral drift.
- **Architect (Human / Loopdive)**: owns system design, strategic constraints, runtime boundaries, and platform-facing product decisions.

### Why It Matters

This model is designed around one claim:

**Velocity is our moat.**

The project is optimized for:

- short implementation-to-validation cycles
- continuous spec-aligned compiler iteration
- rapid backlog triage from conformance data
- keeping product direction, engineering execution, and QA tightly coupled

## Licensing

This repository is licensed under the **GNU Affero General Public License v3.0 only**. See [LICENSE](./LICENSE).

### Community License

- Source code in this repository is available under **AGPL-3.0-only**
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

## Development

Install dependencies:

```bash
pnpm install
```

Run the local development loop:

```bash
pnpm typecheck
pnpm lint
npm test
```

Start the browser playground:

```bash
pnpm dev
```

Additional contributor workflow details, including CLA terms, are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Project Links

- [Playground](https://loopdive.github.io/js2wasm/playground/)
- [Roadmap](./ROADMAP.md)
- [Architecture Notes](./CLAUDE.md)
- [Contributing](./CONTRIBUTING.md)

## Trademark Disclaimer

JavaScript is a trademark or registered trademark of Oracle in the United States and other countries. This project is independent from Oracle and is not endorsed by, sponsored by, or affiliated with Oracle.
