---
id: 949
title: "Research: Integrate Chris Fallin's JS-to-Wasm Blog Series into Documentation"
status: done
created: 2026-04-04
updated: 2026-04-14
completed: 2026-04-14
priority: medium
feasibility: easy
reasoning_effort: high
goal: platform
tags: [documentation, competitive-analysis, strategy]
---
# Research: Integrate Chris Fallin's JS-to-Wasm Blog Series into Documentation

## Summary

Chris Fallin (Cranelift tech lead, now Senior Architect at F5/Fastly) published a three-part blog series in 2023–2024 detailing the Bytecode Alliance's approach to compiling JavaScript to WebAssembly. His work—which culminated in a PLDI 2025 paper—represents the most technically detailed public description of the architecture behind StarlingMonkey's AOT compilation. This issue tracks integrating these findings into our own documentation, competitive positioning, and architecture notes.

## Source Material

1. **Part 1 — Portable Baseline Interpreter (PBL)**
   [cfallin.org/blog/2023/10/11/spidermonkey-pbl](https://cfallin.org/blog/2023/10/11/spidermonkey-pbl/)
   *Oct 2023* — Portable interpreter for SpiderMonkey inside Wasm, with inline cache (IC) support. ~2× speedup over generic interpreter.
1. **Part 2 — Ahead-of-Time JS Compilation**
   [cfallin.org/blog/2024/08/27/aot-js](https://cfallin.org/blog/2024/08/27/aot-js/)
   *Aug 2024* — Turns IC-based execution into a fully AOT compiler. JS functions become skeleton code with indirect calls to a corpus of 2,367 precompiled IC stubs. 2.77× geomean speedup on Octane (up to 4.39×).
1. **Part 3 — weval / Partial Evaluation**
   [cfallin.org/blog/2024/08/28/weval](https://cfallin.org/blog/2024/08/28/weval/)
   *Aug 2024* — Compiler backends derived automatically from the interpreter via the first Futamura projection. weval (Wasm partial evaluator) specializes the interpreter with constant bytecode using context-sensitivity. Core implementation: ~2,400 lines of Rust.

**Additional references:**

- weval tool: [github.com/cfallin/weval](https://github.com/cfallin/weval)
- waffle (SSA framework): [github.com/cfallin/waffle](https://github.com/cfallin/waffle)
- StarlingMonkey AOT integration: [bytecodealliance/StarlingMonkey#91](https://github.com/bytecodealliance/StarlingMonkey/pull/91)
- weval PLDI 2025 paper: preprint linked from [cfallin.org](https://cfallin.org/)
- Surma's related exploration (Shopify/Javy context): [surma.dev/things/compile-js](https://surma.dev/things/compile-js/)

## Key Technical Findings

### StarlingMonkey/weval Architecture (What They Do)

- **Bundled runtime**: SpiderMonkey compiled to Wasm (~8 MB module). Full engine in-sandbox.
- **Two dispatch layers**: JS bytecode dispatch → IC stub dispatch. Even with AOT, every operator goes through an indirect call to an IC stub.
- **Compilation = partial evaluation of interpreter**: weval takes the PBL interpreter loop + constant bytecode and specializes via Futamura projection. The "compiler" is derived from the interpreter—not a direct translation.
- **IC corpus**: 2,367 precompiled CacheIR stub sequences, gathered from the SpiderMonkey test suite. Novel IC bodies at runtime fall back to generic interpreter.
- **Snapshot-based phasing**: Wizer snapshots the module after JS parsing, weval specializes over the heap snapshot, appends new functions. Fully AOT but requires the snapshot toolchain.
- **No Wasm GC**: Targets linear memory Wasm (wasm32-wasi). SpiderMonkey manages its own GC heap inside linear memory.
- **Performance ceiling**: 2.77× over interpreter on Octane. Native SpiderMonkey baseline compiler achieves ~5×, so room to grow. Profile-guided IC inlining (Winliner) is the planned next step.

### What js2wasm Does Differently

| Dimension | StarlingMonkey + weval | js2wasm |
|---|---|---|
| **Runtime overhead** | ~8 MB bundled SpiderMonkey | Zero bundled runtime |
| **Compilation strategy** | Partial evaluation of interpreter | Direct JS → Wasm GC translation |
| **Type handling** | IC stubs with indirect dispatch | Wasm GC type system (structs, arrays, i31ref) |
| **GC** | SpiderMonkey's own GC in linear memory | Host GC via Wasm GC proposal |
| **Module size** | Large (engine + bytecode + IC corpus) | Small (only compiled output) |
| **Sandboxability** | One engine instance per sandbox | Per-module, zero-cost with multi-memory |
| **Warm-up** | None (AOT), but snapshot build step | None, direct compilation |
| **Spec coverage** | ~100% (SpiderMonkey) | ~41% test262 (active development) |
| **Edge deployment** | Feasible but heavy | Designed for it |

### Fallin's Own Framing Validates Our Approach

Chris explicitly identifies the core problem js2wasm solves:

> *"A naive compiler would generate a large amount of code for this simple expression that performs type checks and dispatches to one of these different cases. For both runtime performance reasons and code-size reasons, this is impractical."* (Part 2)

His solution is to keep the full engine and add IC dispatch. Our solution is to leverage Wasm GC's type system to make the "naive" direct compilation practical—structs, tagged unions via i31ref, and host GC eliminate the need for a bundled runtime entirely.

He also acknowledges direct-compilation projects:

> He lists porffor (39% test262 at time of writing) as a comparable approach, notes its use of core Wasm only, and contrasts it with IC-based specialization. js2wasm's use of Wasm GC proposals is a distinct third path—neither core-Wasm-only (porffor) nor bundled-engine (StarlingMonkey).

### Competitive Positioning Implications

1. **"Impossible" narrative**: The BA's implicit position that direct JS→Wasm compilation without a bundled runtime is impractical is contradicted by js2wasm's existence and trajectory. Fallin's series makes the strongest *technical* case for why it's hard—but his solution's complexity (weval + Wizer + PBL + IC corpus + SpiderMonkey) is itself evidence that a simpler direct path has value.
1. **Edge runtime fit**: Fallin acknowledges the per-request isolation model and instant-start requirements. StarlingMonkey's ~8 MB module size is a real constraint for edge platforms with tight limits (e.g., Shopify's 250 KB cap, as noted in Surma's post). js2wasm's zero-runtime approach is structurally better suited.
1. **Chris as potential ally**: He validated our resource-handle + byte-wise accessor pattern on GitHub issue #626. He's technically sympathetic to novel approaches and now at F5 (which runs Fastly Compute, a primary target platform for js2wasm). His blog explicitly wishes porffor-style projects well.

## Documentation Updates Required

### 1. README.md — Comparison Section

Add or update the "How js2wasm differs" section to reference Fallin's architecture as the canonical description of the StarlingMonkey approach. Key points:

- Two dispatch layers (JS bytecode → IC stubs) vs. direct compilation
- ~8 MB bundled runtime vs. zero runtime
- Link to Part 2 as authoritative source

### 2. docs/architecture.md (or equivalent)

Add a "Related Work" or "Landscape" section covering:

- StarlingMonkey + weval (Fallin's series)
- porffor (core Wasm, no GC)
- Javy/QuickJS (interpreter-only, no compilation)
- Static Hermes (type-annotated subset)
- AssemblyScript (TS-like, not JS)
  Position js2wasm as the Wasm GC direct-compilation path.

### 3. docs/competitive-analysis.md (new)

Dedicated comparison document:

- Technical architecture comparison table (from above)
- Performance model: why direct Wasm GC compilation can outperform IC dispatch for common patterns
- Spec coverage trajectory: our test262 progress rate vs. established projects
- Module size analysis: projected js2wasm output sizes vs. StarlingMonkey

### 4. Pitch / Case Study Materials

Update any Anthropic case study draft, Sovereign Tech Fellowship application, or Claude for Open Source application to reference Fallin's series as:

- Evidence of industry investment in the problem space
- Technical validation that the problem is hard and current solutions are heavy
- Proof that a simpler, lighter approach has market demand (edge runtimes, Shopify, etc.)

### 5. GitHub Issue #626 Context

Cross-reference Fallin's involvement: he validated the resource-handle + accessor pattern for intra-module sandboxing. His blog series provides additional context for why per-module sandboxing (which js2wasm enables naturally) matters—he describes the instance-per-request isolation model at length in Part 2.

## Action Items

- [ ] Update README comparison section with StarlingMonkey/weval architecture summary
- [ ] Create or update architecture/landscape documentation
- [ ] Create `docs/competitive-analysis.md` with detailed technical comparison
- [ ] Update pitch materials to reference Fallin's series
- [ ] Add links to Fallin's posts in relevant code comments (e.g., IC-equivalent code paths)
- [ ] Consider writing a blog post or README section: "Why direct compilation?" using Fallin's own problem framing as the setup
