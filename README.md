<p align="center">
  <img src="./playground/image.png" alt="ts2wasm" width="300" />
</p>

# ts2wasm

AOT compiler that compiles a strict subset of TypeScript directly to WebAssembly with the GC proposal.

Runs entirely in the browser – no server, no build step for user code.

```
TS Source (String) → tsc Parser+Checker → Codegen → Wasm GC Binary (Uint8Array) → WebAssembly.instantiate()
```

## Why ts2wasm?

TypeScript normally transpiles to JavaScript, which requires a JS engine to run and provides no sandboxing between modules – any module can access globals, the filesystem, the network, or mutate shared state. ts2wasm compiles TypeScript directly to WebAssembly instead, which unlocks features that regular TS/JS does not have:

- **Run untrusted TypeScript safely in-process** – a Wasm module runs in a sandboxed linear memory with no access to the host filesystem, network, or globals unless explicitly imported. No need to spin up a separate isolate or subprocess. This helps limit the blast radius of security vulnerabilities and supply chain attacks.
- **No runtime embedding required** – Run TypeScript in environments without a JS engine like embedded systems, Wasm-only runtimes (wasmtime, wasmer, wazero), or any host that speaks Wasm but not JavaScript. because ts2wasm targets Wasm GC, the engine manages memory and garbage collection natively. There is no runtime, allocator, or standard library bundled into the output. Compiled modules are in the range of a few hundred bytes to a few kilobytes – smaller than what virtually any other language can achieve when compiling to Wasm. This makes tiny ESM style modules practical.
- **No need to think about glue code** – ts2wasm provides a helper function to create bindings for JS and DOM APIs transparently, so you can use them in your TypeScript code without having to adapt your code given you don't use any features that are not supported by ts2wasm. Glue code for JS and DOM APIs is provided once by the host, not per module, Support for the upcoming `wasm:js-string` built-in is already present.

## Example

Here is a regular TypeScript file with 962 bytes that compiles to 1.1kb of WebAssembly:

```ts
export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

export function main(): void {
  const app = document.createElement("div");
  app.style.fontFamily = "system-ui, sans-serif";
  app.style.padding = "2rem";

  const h1 = document.createElement("h1");
  h1.textContent = "Hello from WebAssembly!";
  h1.style.color = "white";
  app.appendChild(h1);

  const p = document.createElement("p");
  p.textContent = "fib(10) = " + fib(10).toString();
  p.style.color = "#999";
  app.appendChild(p);

  const btn = document.createElement("button");
  btn.textContent = "Run fib(20)";
  btn.style.padding = "0.5rem 1rem";
  btn.style.fontSize = "2rem";
  btn.style.border = "none";
  btn.style.borderRadius = "10px";
  btn.style.backgroundColor = "red";
  btn.style.color = "#fff";
  app.appendChild(btn);

  document.body.appendChild(app);
  document.body.style.backgroundColor = "black";
  console.log("page ready");
}
```

renders this in the browser:

![Screenshot](./screenshot.png)

The module analyzer shows the size of the WebAssembly binary and the WAT text for the compiled module.

![Module Analyzer](./treemap.png)

## Quickstart

```bash
pnpm install
pnpm test        # 103 tests
pnpm dev         # Start playground
```

## CLI

```bash
ts2wasm input.ts [options]
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
import { compile } from "ts2wasm";

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

## Supported TypeScript Subset

| Feature              | Example                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| Arithmetic           | `a + b`, `a * b`, `a / b`, `-x`                                                       |
| Comparisons          | `<`, `<=`, `>`, `>=`, `===`, `!==`                                                    |
| Logical operators    | `&&`, `\|\|`, `!`                                                                     |
| Variables            | `let x: number = 10;`, `const y: number = 20;`                                        |
| If/Else              | `if (x > 0) { ... } else { ... }`                                                     |
| While loop           | `while (i < n) { ... }`                                                               |
| For loop             | `for (let i: number = 0; i < n; i = i + 1) { ... }`                                   |
| Break/Continue       | `break;`, `continue;`                                                                 |
| Functions            | Named, recursive, multiple exports, optional parameters                               |
| Ternary              | `x > 0 ? x : -x`                                                                      |
| Math builtins        | `Math.sqrt`, `Math.abs`, `Math.floor`, `Math.ceil`, `Math.min`, `Math.max`, `Math.PI` |
| Interfaces → Structs | `interface Point { x: number; y: number }`                                            |
| Property access      | `p.x`, `p.y`                                                                          |
| Object literals      | `{ x: 1, y: 2 }`                                                                      |
| Destructuring        | `const { x, y } = p`, `const [a, b] = arr`                                            |
| Optional chaining    | `obj?.prop`, `obj?.method()`                                                          |
| Nullish coalescing   | `a ?? b`                                                                              |
| for-in               | `for (const key in obj)` → compile-time unrolling                                     |
| Arrays               | `[1, 2, 3]`, `arr[i]`, `arr.length` → GC arrays                                       |
| Enums                | `enum Dir { Up, Down }` → inlined constants                                           |
| Strings              | `"hello"`, `a + b`, `===` → externref + wasm:js-string                                |
| String methods       | `.toUpperCase()`, `.indexOf()`, `.slice()`, `.trim()`, etc.                           |
| Template literals    | `` `value: ${x}` `` → string concat chain                                             |
| Do-while             | `do { ... } while (cond)`                                                             |
| Switch               | `switch (x) { case 1: ... break; default: ... }`                                      |
| for-of               | `for (const x of arr) { ... }`                                                        |
| External classes     | `declare class Foo { ... }` → opaque externref                                        |
| console.log          | Numbers, booleans, strings via host imports                                           |
| Export               | `export function ...` → Wasm exports                                                  |
| Import resolution    | `import * as X from "..."` → auto-generated `declare` stubs                           |

### Not yet supported

| Feature               | Notes                                                           |
| --------------------- | --------------------------------------------------------------- |
| Classes               | `class Foo { ... }` — constructors, methods, inheritance        |
| Closures              | Capturing outer variables in nested functions / arrow functions |
| Generics              | `function identity<T>(x: T): T` — runtime type parameters       |
| Spread / rest         | `...args`, `[...arr]`, `{ ...obj }`                             |
| Type narrowing        | `typeof x === "string"`, union types, type guards               |
| Async / await         | `async function`, `Promise`, `await`                            |
| Array methods         | `.map()`, `.filter()`, `.reduce()` with callbacks               |
| Multi-file modules    | `import { foo } from "./bar"` — cross-file compilation          |
| Try / catch           | `try { ... } catch (e) { ... } finally { ... }`                 |
| `var`, `eval`, `with` | Not planned — use `let`/`const` instead                         |

## Architecture

```
┌──────────────────────── Browser ─────────────────────────┐
│                                                           │
│  TS Source (String)                                       │
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
│  │  ts2wasm Codegen             │                         │
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
ts2wasm/
├── src/
│   ├── index.ts              # Public API: compile(), compileToWat()
│   ├── compiler.ts           # Pipeline: parse → check → codegen → emit
│   ├── cli.ts                # CLI entry point (ts2wasm <input.ts>)
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
    ├── compiler.test.ts      # End-to-end: TS → binary → execution
    ├── binary.test.ts        # Binary encoder unit tests
    ├── codegen.test.ts       # Codegen unit tests
    ├── equivalence.test.ts   # TS ↔ Wasm output equivalence
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
