<p align="center">
  <img src="./jswasmlogo.png" alt="js2wasm" width="300" />
</p>

# js2wasm - ECMAScript to WebAssembly Compiler

AOT compiler that compiles Javascript directly to WebAssembly with the GC proposal.

The goal of this project is to compile existing Javascript code to WebAssembly efficiently in terms of performance and module size without requiring to ship a JS runtime with it. This allows to run Javscript code in places where shipping a JS runtime in the module is prohibitively slow and heavy (embedded, serverless) and also aims to provide an opportunity for module based intra process sandboxing to reduce the blast radius if a module turns out to be adversarial by limiting its permissions to a deny by default security model with Object Capabilities (OCap) to contain supply chain attacks.

The compiler itself is based on Typescript 6 and needs a JS runtime to compile JS or TS to .wasm which can also be done in the browser or locally with Node.js.

```
JS/TS Source (String) → tsc Parser+Checker → Codegen → Wasm GC Binary (Uint8Array) → WebAssembly.instantiate()
```

## Why js2wasm?

TypeScript normally transpiles to JavaScript, which requires a JS engine to run and provides no sandboxing between modules – any module can access globals, the filesystem, the network, or mutate shared state. js2wasm compiles TypeScript directly to WebAssembly instead, which unlocks features that regular JS/TS does not have:

- **Run untrusted TypeScript safely in-process** – a Wasm module runs in a sandboxed linear memory with no access to the host filesystem, network, or globals unless explicitly imported. No need to spin up a separate isolate or subprocess. This helps limit the blast radius of security vulnerabilities and supply chain attacks.
- **No runtime embedding required** – Run TypeScript in environments without a JS engine like embedded systems, Wasm-only runtimes (wasmtime, wasmer, wazero), or any host that speaks Wasm but not JavaScript. because js2wasm targets Wasm GC, the engine manages memory and garbage collection natively. There is no runtime, allocator, or standard library bundled into the output. Compiled modules are in the range of a few hundred bytes to a few kilobytes – smaller than what virtually any other language can achieve when compiling to Wasm. This makes tiny ESM style modules practical.
- **No need to think about glue code** – js2wasm provides a helper function to create bindings for JS and DOM APIs transparently, so you can use them in your TypeScript code without having to adapt your code given you don't use any features that are not supported by js2wasm. Glue code for JS and DOM APIs is provided once by the host, not per module, Support for the upcoming `wasm:js-string` built-in is already present.

## Example

Idiomatic DOM code compiles directly to Wasm plus a small set of host imports:

```ts
export function main(): void {
  const card = document.createElement("div");
  card.textContent = "Hello from Wasm";
  document.body.appendChild(card);
}
```

```wat
(module
  (import "env" "global_document" (func $global_document (result externref)))
  (import "env" "Document_createElement" (func $Document_createElement (param externref externref) (result externref)))
  (import "env" "Document_get_body" (func $Document_get_body (param externref) (result externref)))
  (import "env" "Element_set_textContent" (func $Element_set_textContent (param externref externref)))
  (import "env" "Element_appendChild" (func $Element_appendChild (param externref externref) (result externref)))
  (import "string_constants" "div" (global $div externref))
  (import "string_constants" "Hello from Wasm" (global $hello externref))
  (func $main (export "main")
    (local $doc externref)
    (local $card externref)
    call $global_document
    local.tee $doc
    global.get $div
    call $Document_createElement
    local.tee $card
    global.get $hello
    call $Element_set_textContent
    local.get $doc
    call $Document_get_body
    local.get $card
    call $Element_appendChild
    drop))
```

![Playground](./playground.png)

## Try it

**[Live Playground →](https://loopdive.github.io/js2wasm/)** — compile and run TypeScript as WebAssembly in your browser. No install needed.

The playground was built for dogfooding and analysis during development. It provides:

- **Live compiler** — edit TypeScript, see compiled Wasm instantly (< 50ms for small programs)
- **Preview panel** — rendered output with DOM API support (the default example is a booking calendar rendered entirely by WebAssembly)
- **WAT inspector** — view the generated WebAssembly Text Format for any compiled module
- **Module analyzer** — treemap visualization of binary size by function
- **Import/export viewer** — see what the module imports from the host and what it exports
- **Error diagnostics** — TypeScript errors and Wasm validation errors with source locations
- **test262 explorer** — browse and run ECMAScript conformance tests against the compiler
- **Multiple examples** — DOM manipulation, async/await, generators, classes, TypedArrays

## Quickstart

```bash
pnpm install
pnpm test        # 195 tests
pnpm dev         # Start playground locally
```

## CLI

```bash
js2wasm input.ts [options]
```

| Option            | Description                               |
| ----------------- | ----------------------------------------- |
| `-o, --out <dir>` | Output directory (default: same as input) |
| `--wat`           | Emit only WAT to stdout                   |
| `--no-wat`        | Skip WAT output                           |
| `--no-dts`        | Skip .d.ts output                         |

Output files: `<name>.wasm`, `<name>.wat`, `<name>.d.ts`, `<name>.imports.js`

## API

```ts
import { compile } from "js2wasm";

const result = compile(`
  export function add(a: number, b: number): number {
    return a + b;
  }
`);

if (result.success) {
  const imports = {
    env: {
      console_log_number: (v: number) => console.log(v),
      console_log_bool: (v: number) => console.log(!!v),
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as any;
  console.log(exports.add(2, 3)); // 5
}
```

### `compile(source, options?): CompileResult`

```ts
interface CompileResult {
  binary: Uint8Array; // Wasm GC binary
  wat: string; // WAT text (debug)
  dts: string; // TypeScript declarations for exports/imports
  importsHelper: string; // JS module with createImports() helper
  success: boolean;
  errors: CompileError[];
  stringPool: string[]; // String literals used in source
}

interface CompileOptions {
  emitWat?: boolean; // default: true
  moduleName?: string;
}
```

### `compileToWat(source): string`

Returns only the WAT text (debug).

## ES Conformance

js2wasm passes **15,159 / 42,934** tests in the default official test262 scope (35.3%), or **15,159 / 48,174** across the full suite including proposals (31.5%). Conformance is improving with each sprint — see the [live dashboard](https://loopdive.github.io/js2wasm/dashboard/) for the latest numbers and trend charts.

### What Works Well

**Compiled to native Wasm (no host imports needed):**

- **Basic types** — number (f64/i32), string (WasmGC arrays), boolean, null, undefined
- **Functions** — declarations, expressions, closures, arrow functions, default/rest parameters
- **Classes** — constructors, methods, getters/setters, inheritance, `super`, static members, private fields
- **Control flow** — if/else, switch, for, while, do-while, for-of, for-in, labeled break/continue
- **Error handling** — try/catch/finally with native Wasm exceptions
- **Destructuring**, spread operator, rest parameters
- **Template literals** and tagged templates
- **Math** — compiled to Wasm f64 instructions (83% test262 coverage)
- **Optional chaining** (`?.`) and **nullish coalescing** (`??`)
- **Computed property names**, symbols
- **Block scoping** — let/const with proper TDZ semantics
- **TypedArray**, DataView, ArrayBuffer (Wasm linear memory)

**Supported via JS host imports currently (requires a JS runtime):**

- **Collections** — Map, Set, WeakMap, WeakSet (delegated to JS built-ins)
- **RegExp** — exec, match, replace, split (delegated to JS RegExp engine)
- **Promises** — Promise.all, Promise.race, Promise.resolve/reject, async chaining
- **Async/await** and **generators** (including async generators)
- **JSON** — JSON.parse, JSON.stringify
- **Date** — construction and methods (delegated to JS Date)
- **Console** — console.log, console.error (WASI mode uses `fd_write` instead)

### ECMAScript Standard Features Not Yet Supported

| Standard | Feature                                 | Status                                                         | Tests |
| -------- | --------------------------------------- | -------------------------------------------------------------- | ----: |
| ES5      | `with` statement                        | Strict mode only — incompatible with static compilation        |   560 |
| ES5      | Octal escape sequences                  | Forbidden in strict/module mode                                |    16 |
| ES5      | Sloppy mode behaviors                   | js2wasm compiles in strict mode exclusively                    |     8 |
| ES2015   | Multi-module `import`                   | Single-file compilation; basic multi-file via `compileMulti()` |   783 |
| ES2015   | Proxy                                   | Partial — basic traps work, not all handler methods            |     — |
| ES2015   | Full `arguments` object                 | Partial — basic access works, `arguments.callee` not supported |     — |
| ES2017   | SharedArrayBuffer / Atomics             | Requires shared Wasm memory (not yet available in WasmGC)      |   460 |
| ES2020   | Dynamic `import()`                      | No runtime module loader                                       |   432 |
| ES2020   | BigInt64Array / BigUint64Array          | Not yet implemented                                            |    28 |
| ES2025   | Temporal API                            | Not yet implemented                                            | 4,383 |
| ES2025   | Set methods (union, intersection, etc.) | Not yet implemented                                            |   186 |

### ECMAScript Proposals (Not Yet Standardized)

| Stage   | Feature                          | Tests |
| ------- | -------------------------------- | ----: |
| Stage 3 | Source phase imports             |   211 |
| Stage 3 | Import defer                     |   210 |
| Stage 3 | Map/WeakMap upsert (getOrInsert) |    72 |

### Toolchain Limitations

| Limitation                                                        | Impact           | Issue                            |
| ----------------------------------------------------------------- | ---------------- | -------------------------------- |
| TypeScript 5.x parser does not support Unicode 16.0.0 identifiers | 82 tests skipped | [#832](plan/issues/ready/832.md) |

### Common Failure Patterns

The remaining 62% of test262 failures fall into these categories:

| Pattern                   | Affected tests | Description                                                                                                  |
| ------------------------- | -------------: | ------------------------------------------------------------------------------------------------------------ |
| Assertion failures        |        ~10,350 | Built-in method edge cases, spec-mandated error types, or property attributes that differ from the spec      |
| Type errors               |         ~6,130 | Missing or incorrect type coercions at runtime, especially for untyped/dynamic code patterns                 |
| Property descriptor model |         ~1,260 | `Object.defineProperty`, `Object.getOwnPropertyDescriptor`, and related descriptor operations are incomplete |
| Null dereference          |         ~1,080 | Prototype chain lookups that reach null before finding the expected property                                 |
| Compile errors            |         ~1,880 | Syntax or type patterns the compiler does not yet handle                                                     |
| Promise/async edge cases  |           ~210 | Microtask scheduling differences between Wasm and native JS engines                                          |

### Conformance Trend

Conformance is improving with each release. The full test262 conformance report with historical trend data is available at `benchmarks/results/report.html`.

### Benchmarks

<!-- AUTO:BENCHMARKS:START -->

```text
Benchmark     WASM          JS        Ratio     n
──────────────────────────────────────────────────────────────
  array         29.0 µs      30.8 µs    WASM 1.06× 32.510
  dom          100.7 µs      94.9 µs    JS 1.06×   10.670
  fib            2.4 ms       8.2 ms    WASM 3.38× 400
  loop         992.3 µs       1.6 ms    WASM 1.58× 1.010
  string         2.9 µs       2.5 µs    JS 1.12×   300.810
  style         95.1 µs      81.0 µs    JS 1.17×   9.890
```

<!-- AUTO:BENCHMARKS:END -->

## JS Host Dependencies

Compiled modules currently require a JS host to provide certain imports. The goal is pure Wasm with no JS dependency (see [#682](plan/issues/ready/682.md)), but these host imports remain:

| Category                | Imports                                                                | Status                                                                                                                                 | Tracking                         |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **String ops**          | `wasm:js-string`, native i16 arrays, or UTF-8                          | `wasm:js-string` builtins (native in V8), WasmGC i16 arrays (standalone), or UTF-8 i8 arrays (Component Model) — not a host dependency | `--nativeStrings` flag           |
| **Property access**     | `__extern_get`, `__extern_set`, `__extern_length`                      | Fallback for untyped objects                                                                                                           | —                                |
| **Math**                | `Math.*` methods (sin, cos, sqrt, etc.)                                | Wasm has no math stdlib                                                                                                                | —                                |
| **Console**             | `console.log`, `console.warn`, `console.error`                         | I/O requires host                                                                                                                      | WASI `fd_write` alt              |
| **RegExp**              | `RegExp_new`, `.test()`, `.exec()`                                     | Needs Wasm regex engine                                                                                                                | [#682](plan/issues/ready/682.md) |
| **Generators**          | `__create_generator`, `__gen_next`, etc.                               | Host-delegated iterator protocol                                                                                                       | [#681](plan/issues/ready/681.md) |
| **Iterators**           | `__iterator`, `__iterator_next`, `__iterator_done`, `__iterator_value` | Host-delegated iteration                                                                                                               | [#681](plan/issues/ready/681.md) |
| **Promises**            | `Promise_all`, `Promise_race`, `Promise_new`, `Promise_then`, etc.     | Async requires host event loop                                                                                                         | —                                |
| **JSON**                | `JSON_stringify`, `JSON_parse`                                         | Needs Wasm JSON parser                                                                                                                 | —                                |
| **typeof**              | `__typeof`                                                             | Runtime type tag for externref                                                                                                         | —                                |
| **parseInt/parseFloat** | `parseInt`, `parseFloat`                                               | String→number parsing                                                                                                                  | —                                |
| **Extern classes**      | `Map_new`, `Set_new`, `RegExp_new`, `Date_new`, etc.                   | Constructor delegation                                                                                                                 | Per-class                        |
| **Boxing**              | `__box_number`                                                         | f64→externref conversion                                                                                                               | —                                |

Use `--target wasi` to emit WASI imports (`fd_write`, `proc_exit`) instead of JS host for I/O.
Use `--nativeStrings` to use WasmGC i16 arrays instead of `wasm:js-string`.

## Architecture

```
┌──────────────────────── Browser ─────────────────────────┐
│                                                           │
│  JS/TS Source (String)                                    │
│       │                                                   │
│       ▼                                                   │
│  ┌──────────────────────────────┐                         │
│  │  typescript Compiler API     │                         │
│  │  - createSourceFile (parse)  │                         │
│  │  - createProgram (check)     │                         │
│  │  - TypeChecker               │                         │
│  └──────────────┬───────────────┘                         │
│                 │ Typed AST                               │
│                 ▼                                         │
│  ┌──────────────────────────────┐                         │
│  │  js2wasm Codegen             │                         │
│  │  - AST → IR                  │                         │
│  │  - IR → Wasm Binary          │                         │
│  │  - IR → WAT Text (debug)     │                         │
│  └──────────────┬───────────────┘                         │
│       ┌─────────┴──────────┐                              │
│       ▼                    ▼                              │
│  Wasm GC Binary       WAT Text                           │
│  (Uint8Array)         (string)                           │
│       │                                                   │
│       ▼                                                   │
│  WebAssembly.instantiate(binary, imports)                 │
└───────────────────────────────────────────────────────────┘
```

## Project Structure

```
js2wasm/
├── src/
│   ├── index.ts              # Public API: compile(), compileToWat()
│   ├── compiler.ts           # Pipeline: parse → check → codegen → emit
│   ├── cli.ts                # CLI entry point (js2wasm <input.ts>)
│   ├── import-resolver.ts    # import → declare stub transformation
│   ├── checker/
│   │   ├── index.ts          # tsc integration with in-memory CompilerHost
│   │   └── type-mapper.ts    # ts.Type → WasmType mapping
│   ├── ir/
│   │   ├── index.ts          # Re-exports
│   │   └── types.ts          # WasmModule, Function, Instruction, ValType
│   ├── codegen/
│   │   ├── index.ts          # Typed AST → IR orchestration
│   │   ├── expressions.ts    # Expression → IR instructions
│   │   ├── statements.ts     # Statement → IR instructions
│   │   ├── functions.ts      # Function declarations, optional params
│   │   └── structs.ts        # Interface → GC struct types
│   ├── emit/
│   │   ├── binary.ts         # IR → Wasm binary (Uint8Array)
│   │   ├── encoder.ts        # LEB128, section encoding
│   │   ├── opcodes.ts        # Wasm opcodes incl. GC (0xFB prefix)
│   │   └── wat.ts            # IR → WAT text (debug output)
│   └── runtime/
│       └── builtins.ts       # Runtime functions
├── playground/
│   ├── index.html            # IDE layout: dual editor + output panels
│   ├── main.ts               # Compile, run, file management
│   ├── wasm-treemap.ts       # Binary size treemap visualization
│   └── wasm-treemap.html     # Standalone treemap page
└── tests/
    ├── compiler.test.ts      # End-to-end: JS/TS → binary → execution
    ├── binary.test.ts        # Binary encoder unit tests
    ├── codegen.test.ts       # Codegen unit tests
    ├── equivalence.test.ts   # JS/TS ↔ Wasm output equivalence
    ├── strings.test.ts       # String/externref tests
    ├── arrays-enums.test.ts  # Array + enum tests
    ├── anon-struct.test.ts   # Anonymous object type tests
    ├── control-flow.test.ts  # Control flow edge cases
    ├── externref.test.ts     # External class tests
    ├── optional-params.test.ts
    ├── import-resolver.test.ts
    └── fixtures/             # .ts test fixtures
```

## Codegen Rules

**number → f64 (unboxed)**

```ts
export function add(a: number, b: number): number {
  return a + b;
}
```

```wat
(func $add (export "add") (param f64) (param f64) (result f64)
  local.get 0
  local.get 1
  f64.add
  return)
```

**Interface → GC Struct**

```ts
interface Point {
  x: number;
  y: number;
}
```

```wat
(type $Point (struct (field $x (mut f64)) (field $y (mut f64))))
```

**boolean → i32** (0 = false, 1 = true)

**string → externref** (host-managed via wasm:js-string)

**void → no return value**

## Scripts

| Script            | Description           |
| ----------------- | --------------------- |
| `pnpm build`      | Build library (Vite)  |
| `pnpm dev`        | Playground dev server |
| `pnpm test`       | Run tests (Vitest)    |
| `pnpm test:watch` | Tests in watch mode   |
| `pnpm lint`       | Linting (Biome)       |
| `pnpm typecheck`  | TypeScript check      |

## Toolchain

- **Language:** TypeScript (strict mode)
- **Parser & Type Checker:** `typescript` Compiler API
- **Output:** `Uint8Array` (Wasm binary) + WAT text + `.d.ts` + imports helper
- **Package Manager:** pnpm
- **Bundler:** Vite
- **Test Framework:** Vitest
- **Linting:** Biome

## Sponsor

Looking for a sponsor to support ongoing development. If you're interested, please reach out.

## License

MIT

---

Made with ❤️ by [ttraenkler](https://github.com/ttraenkler) assisted by [Claude Code](https://claude.ai/code).
