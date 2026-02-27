# ts2wasm

AOT compiler that compiles a strict subset of TypeScript directly to WebAssembly with the GC proposal.

Runs entirely in the browser – no server, no build step for user code.

```
TS Source (String) → tsc Parser+Checker → Codegen → Wasm GC Binary (Uint8Array) → WebAssembly.instantiate()
```

## Quickstart

```bash
pnpm install
pnpm test        # 37 tests
pnpm dev         # Start playground
```

## API

```ts
import { compile } from 'ts2wasm';

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
  binary: Uint8Array;       // Wasm GC binary
  wat: string;              // WAT text (debug)
  success: boolean;
  errors: CompileError[];
}

interface CompileOptions {
  emitWat?: boolean;        // default: true
  moduleName?: string;
}
```

### `compileToWat(source): string`

Returns only the WAT text (debug).

## Supported TypeScript Subset

| Feature | Example |
|---------|---------|
| Arithmetic | `a + b`, `a * b`, `a / b`, `-x` |
| Comparisons | `<`, `<=`, `>`, `>=`, `===`, `!==` |
| Logical operators | `&&`, `\|\|`, `!` |
| Variables | `let x: number = 10;`, `const y: number = 20;` |
| If/Else | `if (x > 0) { ... } else { ... }` |
| While loop | `while (i < n) { ... }` |
| For loop | `for (let i: number = 0; i < n; i = i + 1) { ... }` |
| Break/Continue | `break;`, `continue;` |
| Functions | Named, recursive, multiple exports |
| Ternary | `x > 0 ? x : -x` |
| Math builtins | `Math.sqrt`, `Math.abs`, `Math.floor`, `Math.ceil`, `Math.min`, `Math.max`, `Math.PI` |
| Interfaces → Structs | `interface Point { x: number; y: number }` |
| Property access | `p.x`, `p.y` |
| Object literals | `{ x: 1, y: 2 }` |
| console.log | Numbers and booleans via host imports |
| Export | `export function ...` → Wasm exports |

### Not supported (Phase 1)

`var`, `eval`, `with`, classes, `async`/`await`, `try`/`catch`, destructuring, spread, template literals, generics, strings (runtime), arrays (runtime).

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
│   │   ├── functions.ts      # Functions (reserved for closures)
│   │   └── structs.ts        # Interface → GC struct (reserved)
│   ├── emit/
│   │   ├── binary.ts         # IR → Wasm binary (Uint8Array)
│   │   ├── encoder.ts        # LEB128, section encoding
│   │   ├── opcodes.ts        # Wasm opcodes incl. GC (0xFB prefix)
│   │   └── wat.ts            # IR → WAT text (debug output)
│   └── runtime/
│       └── builtins.ts       # Runtime functions (reserved)
├── playground/
│   ├── index.html            # Editor + WAT/Console/Errors
│   └── main.ts               # Compile & run logic
└── tests/
    ├── compiler.test.ts      # End-to-end: TS → binary → execution
    ├── binary.test.ts        # Binary encoder unit tests
    ├── codegen.test.ts       # Codegen unit tests
    └── fixtures/             # .ts test files
```

## Codegen Rules

**number → f64 (unboxed)**

```ts
export function add(a: number, b: number): number { return a + b; }
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
interface Point { x: number; y: number }
```
```wat
(type $Point (struct (field $x (mut f64)) (field $y (mut f64))))
```

**boolean → i32** (0 = false, 1 = true)

**void → no return value**

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm build` | Build library (Vite) |
| `pnpm dev` | Playground dev server |
| `pnpm test` | Run tests (Vitest) |
| `pnpm test:watch` | Tests in watch mode |
| `pnpm lint` | Linting (Biome) |
| `pnpm typecheck` | TypeScript check |

## Toolchain

- **Language:** TypeScript (strict mode)
- **Parser & Type Checker:** `typescript` Compiler API
- **Output:** `Uint8Array` (Wasm binary) + WAT text
- **Package Manager:** pnpm
- **Bundler:** Vite
- **Test Framework:** Vitest
- **Linting:** Biome

## License

MIT
