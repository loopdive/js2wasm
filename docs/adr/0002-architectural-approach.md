# ADR-002 — Architectural approach: AOT + WasmGC over embed-a-runtime and new-language alternatives

**Status**: Accepted
**Date**: 2026-04-27

## Context

Three broad architectural strategies exist for running JavaScript in Wasm
environments:

**Strategy A — Embed a complete JS runtime** (interpreter or JIT engine
compiled to Wasm). Correct semantics, because it *is* a JS engine. The binary
carries the full engine (~300KB–8MB overhead per module). GC is internal to
the engine, independent of the host GC. JIT engines require runtime code
generation — this is disabled in most serverless and edge Wasm hosts for
sandbox-isolation reasons. When JIT is disabled, a JIT-capable engine falls
back to its interpreter or baseline compiler, eliminating its primary
performance advantage.

This ceiling can be partially recovered through ahead-of-time
pre-initialization and partial evaluation: a pre-initializer (e.g. Wizer)
snapshots the engine after startup, eliminating initialization cost from the
hot path; a partial evaluator (e.g. Weval) can specialize the interpreter
against the known JS bytecode at build time, effectively doing offline JIT
and producing specialized Wasm that approaches AOT performance. These
techniques blur the boundary between "embed a runtime" and "AOT compile" —
the compilation work is shifted from runtime to build time. The remaining
costs are: the engine binary is still bundled (size overhead); the
pre-initialization / partial-evaluation toolchain is an additional build-time
dependency; and the resulting module is specialized to one program, losing
the generic-engine property that made the approach attractive. At that
point the approach converges toward AOT compilation, with a more complex
pipeline.

**Strategy B — Define a new Wasm-native language**. TypeScript syntax with
Wasm-native semantics (no prototype chain, no dynamic `any`, no closures over
mutable variables without explicit ref types). Maps directly to Wasm types.
Excellent performance because the language is Wasm-shaped. But it is *not* a
JS compiler — existing JavaScript and npm packages cannot be used; all code
must be rewritten. Breaks the compatibility goal.

**Strategy C — AOT compile JS with linear memory**. No embedded runtime, so
no binary-size or startup overhead from a bundled engine. Full AOT
performance potential. But JS heap objects must live somewhere — a custom GC
in Wasm linear memory is required, operating independently of the host GC.
Memory layout, allocation, and collection must all be implemented. Does not
leverage the host's garbage collector or the emerging WasmGC type system.

**Strategy D — AOT compile JS with WasmGC** (this project). No embedded
runtime. JS objects are lowered to typed WasmGC structs; the host GC owns
the heap. WasmGC struct types map naturally to JS object shapes. Aligned
with the Component Model (WasmGC records ↔ component types). JIT is never
relevant — the module is pre-compiled.

## Decision

Adopt Strategy D: AOT compilation with WasmGC as the type system. No
embedded runtime; no custom GC; no new language.

## Consequences

Positive: the binary contains only compiled program code — size scales with
the JS source, not with a bundled engine. Cold start is proportional to Wasm
instantiation, not engine initialization. In serverless/edge environments
where JIT is disabled, an AOT-compiled module starts and runs at full speed
from the first instruction, whereas an embedded JIT engine operating without
JIT is an interpreter at interpreter speed. The host GC manages the heap —
the compiler does not implement GC. Component Model integration is natural.

Negative: the compiler must implement JS semantics directly in the output
code — correctness burden is entirely on the compiler, not delegated to a
battle-tested engine. WasmGC requires a capable host (wasmtime 44+,
Chrome 119+). Workloads that a JS JIT engine would heavily optimize (hot
polymorphic dispatch) are addressed through three complementary layers that
do not require reimplementing speculative optimization in the compiler:
(1) the compiler's own IR optimization pipeline (dead-code elimination,
inlining, monomorphization, constant folding) which operates on typed IR
before Wasm emission; (2) post-compilation Wasm optimization via `wasm-opt`
(`-O4`), which applies Binaryen's full optimization suite to the Wasm output
regardless of what the compiler emitted; and (3) the host Wasm runtime's JIT
(where available), which optimizes hot Wasm paths at runtime independently
of the JS compiler. Each layer is available unconditionally or as a flag;
none requires changes to the compiler's analysis logic.

## Alternatives rejected

- **Strategy A** rejected — JIT is disabled in target serverless / edge
  environments; pre-initialization and partial evaluation (Wizer / Weval) can
  recover performance at build time, but doing so converges toward AOT
  compilation with a more complex pipeline and a bundled engine binary that
  js2wasm avoids entirely.
- **Strategy B** rejected because JS compatibility is a hard requirement.
- **Strategy C** rejected in favour of Strategy D — WasmGC eliminates the
  custom-GC implementation cost and aligns better with the Component Model.
