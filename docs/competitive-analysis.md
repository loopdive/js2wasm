# JS-to-Wasm Compilation Landscape

This document surveys the major approaches to running JavaScript in WebAssembly and positions js2wasm within that landscape.

## Overview

There are four distinct architectural patterns for JS-in-Wasm:

1. **Bundled interpreter + AOT specialization** (StarlingMonkey / weval)
2. **Direct AOT compilation to Wasm GC** (js2wasm)
3. **Interpreter-only bundling** (Javy / QuickJS)
4. **Direct AOT to core Wasm** (Porffor)

---

## Comparison Table

| Dimension | Bundled engine (StarlingMonkey) | Direct Wasm GC (js2wasm) | Interpreter (Javy) | Core Wasm (Porffor) |
|---|---|---|---|---|
| Runtime overhead | ~8 MB | Zero | ~869 KB | Zero |
| Compilation strategy | Partial eval of interpreter | Direct translation | None (interpreted) | Direct translation |
| GC | Engine-managed in linear memory | Host GC (Wasm GC proposal) | Engine-managed | Manual (linear memory) |
| Module size | Large | Small (KB range) | Medium | Small |
| Spec coverage | ~100% | ~42% | ~99% | ~50% |
| Warm-up | None (AOT + snapshot) | None | Interpretation overhead | None |
| Wasm GC | No | Yes | No | No |
| Standalone (no JS host) | No (needs Component Model host) | Yes (WASI target) | Yes (WASI only) | Yes |
| Status | Production | Active development | Production | Experimental |

---

## Approach 1: Bundled Engine + AOT Specialization (StarlingMonkey / weval)

### What it does

The full SpiderMonkey JS engine is compiled to WebAssembly (~8 MB module). JS code is not compiled ahead of time — instead, it is interpreted inside Wasm by the engine's portable baseline interpreter (PBL). AOT specialization is achieved via **partial evaluation** (weval): the interpreter is specialized against a fixed JS bytecode image to produce AOT-compiled variants of each JS function.

### Architecture

```
JS source → JS bytecode → SpiderMonkey PBL (in Wasm)
                                  ↓ weval (partial evaluation)
                          Specialized Wasm function per JS function
```

Two dispatch layers:
1. **JS bytecode → IC stub dispatch** — the interpreter dispatches via inline caches
2. **weval specialization** — the first Futamura projection specializes the interpreter with constant bytecode, collapsing dispatch overhead

### Trade-offs

- **Pros**: ~100% spec coverage (inherits SpiderMonkey), production-grade engine, no JS semantics to implement
- **Cons**: ~8 MB baseline overhead (entire engine), requires Component Model host, complex toolchain (SpiderMonkey + weval + waffle)

### References

- [Part 1: Portable Baseline Interpreter](https://cfallin.org/blog/2023/10/11/spidermonkey-pbl/) — Oct 2023
- [Part 2: AOT JS Compilation](https://cfallin.org/blog/2024/08/27/aot-js/) — Aug 2024
- [Part 3: weval / Partial Evaluation](https://cfallin.org/blog/2024/08/28/weval/) — Aug 2024
- [weval tool](https://github.com/cfallin/weval)
- [StarlingMonkey AOT integration PR](https://github.com/bytecodealliance/StarlingMonkey/pull/91)

---

## Approach 2: Direct AOT to Wasm GC (js2wasm)

### What it does

TypeScript/JavaScript source is compiled directly to WasmGC instructions — no engine bundled, no interpreter. The host Wasm runtime provides garbage collection natively via the [Wasm GC proposal](https://github.com/WebAssembly/gc). Output is a pure `.wasm` binary with no runtime overhead.

### Architecture

```
TS/JS source → TypeScript Compiler API (parse + typecheck)
                         ↓
                  js2wasm codegen
                         ↓
          WasmGC binary (structs, arrays, i31ref)
```

TypeScript types map directly to Wasm GC types:

| TypeScript | Wasm |
|---|---|
| `number` | `f64` |
| `boolean` | `i32` |
| `string` | WasmGC array / `externref` |
| `interface` / `class` | GC struct |
| `Array<T>` | GC array |

### Trade-offs

- **Pros**: Zero runtime overhead, tiny output (KB range), host GC (no custom allocator), standalone via WASI, no corporate runtime dependency
- **Cons**: ~42% spec coverage (active development), requires Wasm GC-capable runtime (Chrome, Firefox, wasmtime)

---

## Approach 3: Interpreter-Only Bundling (Javy / QuickJS)

### What it does

[QuickJS](https://bellard.org/quickjs/) — a small, embeddable JS engine — is compiled to Wasm once. The resulting module (~869 KB) is loaded alongside user JS bytecode at runtime. No AOT compilation: JS code is interpreted by QuickJS inside Wasm every time.

### Architecture

```
JS source → QuickJS bytecode compiler (host)
                    ↓
         QuickJS engine .wasm + bytecode blob
                    ↓
             wasmtime / WASI runtime
```

### Trade-offs

- **Pros**: ~99% spec coverage, production-grade, simple toolchain, WASI-native
- **Cons**: ~869 KB baseline overhead, interpretation latency, WASI-only (no browser), QuickJS quirks vs. V8/SpiderMonkey behavior

### Reference

- [Javy](https://github.com/bytecodealliance/javy)

---

## Approach 4: Direct AOT to Core Wasm (Porffor)

### What it does

[Porffor](https://porffor.dev/) compiles JavaScript directly to Wasm bytecode without bundling an engine — similar in intent to js2wasm — but targets **core Wasm (linear memory)** instead of Wasm GC. Objects are managed manually in linear memory rather than using the host GC.

### Architecture

```
JS source → Porffor AST compiler
                   ↓
         Core Wasm (linear memory, no GC types)
```

### Trade-offs

- **Pros**: Zero runtime overhead, small output, no Wasm GC requirement
- **Cons**: ~50% spec coverage, manual memory management (no host GC), no struct subtyping

### Reference

- [Porffor](https://porffor.dev/)

---

## Why Wasm GC?

js2wasm's use of the Wasm GC proposal is a deliberate architectural choice:

- **No allocator needed** — the runtime provides GC natively; the compiler emits type definitions and allocation instructions
- **Struct subtyping** — Wasm GC's nominal type system supports class inheritance directly (`(sub $Base ...)`)
- **i31ref** — tagged integers avoid heap allocation for small integers
- **Interop** — `externref` / `anyref` allow zero-copy bridging between Wasm structs and JS objects

The trade-off is runtime requirement: Wasm GC is available in Chrome 119+, Firefox 120+, and wasmtime 14+, but not in older runtimes.

---

## Related Reading

- Surma's exploration of JS-to-Wasm approaches: [surma.dev/things/compile-js](https://surma.dev/things/compile-js/)
- Bytecode Alliance blog series (links above) — most technically detailed public description of interpreter-based AOT for JS in Wasm
- [js2wasm Architecture](./ARCHITECTURE.md)
- [js2wasm Conformance Dashboard](https://loopdive.github.io/js2wasm/dashboard/)
