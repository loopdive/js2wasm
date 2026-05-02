---
id: 1255
title: "Reference platform scenario: run a Node-oriented example on Wasmtime via Edge.js"
status: ready
created: 2026-04-20
updated: 2026-04-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
language_feature: n/a
goal: platform
es_edition: n/a
---
# #1255 -- Reference platform scenario: run a Node-oriented example on Wasmtime via Edge.js

## Problem

The `js²` deployment story depends on a key distinction that is easy to state but not yet
well demonstrated: preserving a familiar platform surface is not the same thing as keeping
Node.js as the deployment runtime.

We already argue that JavaScript should become a Wasm-native deployment target and that the
remaining host boundary should trend toward explicit APIs rather than a bundled JS engine.
What is missing is a concrete scenario showing that Node-oriented code can move onto a
Wasm-native host while keeping a useful platform surface.

The clearest reference path is Wasmtime plus Edge.js.

## Scenario

Take a small but real Node-oriented example and run it on Wasmtime through Edge.js rather
than Node.js as the deployment runtime.

The scenario should include at least one concrete platform API such as `node:fs` so the
demo proves more than “hello world”. The goal is to show:

- the platform surface can remain useful
- the execution substrate can still move to Wasm
- `js²` is compatible with a world where host APIs are re-provided by the runtime rather
  than inherited from Node.js itself

## Why this matters

This scenario turns an abstract architectural argument into something operational:

- JavaScript can target Wasm-native infrastructure without bundling a JS engine into each
  deployment unit
- the relevant question becomes “which host APIs exist?” rather than “is Node.js present?”
- existing JS/TS code has a plausible migration path toward Wasm-native serverless and edge
  environments

It is also a direct answer to the “what to build next” lesson from MoonBit: provide
concrete, end-to-end deployment surfaces, not only compiler internals.

## Scope

- choose one Node-oriented example worth demonstrating
- run it on Wasmtime through Edge.js
- include at least one real platform capability such as `node:fs`
- document what functionality is being provided by Edge.js / the host
- document what assumptions about a traditional Node runtime are no longer required
- provide a reproducible reference demo and usage instructions

## Non-goals

- no claim of full Node compatibility
- no requirement to support arbitrary npm server stacks in this issue
- no requirement to solve the entire standalone/WASI platform matrix
- no requirement to define the final long-term packaging model in this issue

## Acceptance criteria

- [ ] A non-trivial Node-oriented example runs on Wasmtime via Edge.js
- [ ] The scenario includes at least one concrete API such as `node:fs`
- [ ] The docs clearly explain the distinction between Node-compatible platform APIs and
      Node.js as deployment runtime
- [ ] The scenario is documented as a reference platform path, not as an isolated experiment
- [ ] The result is strong enough to support future demos, partner conversations, and
      launch material

## Related

- #640 WASI HTTP handler
- #1035 WASI hello-fs: console.log + node:fs → WASI fd_write
- #1099 Standalone execution demo — FizzBuzz on Wasmtime, zero JS host
