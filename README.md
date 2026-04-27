# js2wasm

Direct AOT compilation from JavaScript and TypeScript to WebAssembly GC.

`js2wasm` compiles source code into WasmGC binaries without embedding a JavaScript interpreter or shipping a bundled runtime. That removes the runtime tax common in interpreter-in-Wasm and bundled-engine stacks, where interpreters often land in the high-hundreds-of-kilobytes range and full-fledged JavaScript engines in the megabytes, and keeps the output aligned with Wasm-native deployment models.

`js2wasm` is the core compiler product of **Loopdive GmbH**, released under **Apache License 2.0 with LLVM Exceptions** — and developed fully in the open, including its agentic engineering workflow. The repository contains the compiler source, the complete planning surface (`plan/`), and the agent coordination infrastructure (`.claude/`) that a small team uses to ship fixes in parallel.

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

- **52% Test262 compliance**

See the [Playground](https://loopdive.github.io/js2wasm/playground/) and [Roadmap](./ROADMAP.md) for the current public surface.

## Current Status

`js2wasm` is still an active compiler effort, but it is no longer just a research prototype. The project now has:

- **52% Test262 compliance**
- a public browser playground
- ongoing benchmark and compatibility reporting
- both JS-hosted and standalone-oriented compiler work, with standalone support still in progress and not yet the primary conformance path

The project is being positioned for a community-first release while the compiler, runtime boundary, and conformance story continue to harden.

## How It Compares

The core tradeoff in this space is straightforward:

- **bundle an interpreter into Wasm**
- or **compile the program directly to Wasm**

`js2wasm` is in the second category.

| Project | Approach | WasmGC | Standalone story | Output profile | Conformance posture |
| --- | --- | --- | --- | --- | --- |
| **js2wasm** | **Direct AOT to WasmGC** | **Yes** | **Yes, but still in progress and not yet the primary conformance path** | **small compiled modules** | **growing compiler-native conformance** |
| Javy | QuickJS bundled in Wasm | No | WASI-focused | ships engine/runtime | inherits interpreter behavior |
| StarlingMonkey | SpiderMonkey bundled in Wasm | No | host/runtime dependent | ships engine/runtime | inherits interpreter behavior |
| Porffor | AOT to Wasm / linear memory | No | yes | compiler output plus custom runtime model | experimental |

That difference is the main reason `js2wasm` exists. The goal is not “JavaScript in Wasm” in the abstract. The goal is **JavaScript semantics without shipping a JS engine inside the deployed artifact**.

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

### Open Agentic Development

The workflow is not hidden behind a consultancy. It is **in this repository**:

- `plan/issues/` — architect-written implementation specs for every open and completed work item
- `plan/log/dependency-graph.md` — current priorities and what's blocked on what
- `plan/issues/sprints/` — sprint plans and retrospectives
- `.claude/agents/` — agent role definitions (product owner, architect, developer, scrum master)
- `.claude/hooks/` — safety scripts (pre-commit gates, path checks)
- `.claude/skills/` — reusable workflow protocols (test-and-merge, self-merge, harvest-errors)
- `.claude/memory/` — accumulated feedback and learnings shared across sessions

Anyone with a [Claude Code](https://docs.claude.com/claude-code) subscription can clone the repo, spawn a `developer` agent from `.claude/agents/developer.md`, point it at a `status: ready` issue under `plan/issues/sprints/`, and contribute a real fix through the same pipeline the core team uses. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the agentic contribution path.

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

## Development

Additional contributor workflow details, including CLA terms, are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Architecture decisions

The foundational design choices behind `js2wasm` — why WasmGC instead of linear memory, why AOT instead of an embedded engine, how TypeScript annotations are treated, how closures are lowered — are documented as Architecture Decision Records in [`docs/adr/`](./docs/adr/README.md). Each record states the context, the decision, and the consequences in 200–600 words. Start with [ADR-002 (architectural approach)](./docs/adr/0002-architectural-approach.md) and [ADR-001 (hybrid compilation strategy)](./docs/adr/0001-hybrid-compilation-strategy.md); the rest are sub-decisions within that frame.

## Further Reading

- [Playground](https://loopdive.github.io/js2wasm/playground/)
- [Roadmap](./ROADMAP.md)
- [Architecture Decisions](./docs/adr/README.md)
- [Architecture Notes](./CLAUDE.md)
- [Contributing](./CONTRIBUTING.md)

## Trademark Disclaimer

JavaScript is a trademark or registered trademark of Oracle in the United States and other countries. This project is independent from Oracle and is not endorsed by, sponsored by, or affiliated with Oracle.
