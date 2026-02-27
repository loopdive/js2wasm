# ts2wasm

AOT-Compiler der ein striktes Subset von TypeScript direkt zu WebAssembly mit GC-Proposal kompiliert.

Läuft vollständig im Browser – kein Server, kein Build-Step für den User-Code.

```
TS Source (String) → tsc Parser+Checker → Codegen → Wasm GC Binary (Uint8Array) → WebAssembly.instantiate()
```

## Quickstart

```bash
pnpm install
pnpm test        # 37 Tests
pnpm dev         # Playground starten
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
  binary: Uint8Array;       // Wasm GC Binary
  wat: string;              // WAT Text (Debug)
  success: boolean;
  errors: CompileError[];
}

interface CompileOptions {
  emitWat?: boolean;        // default: true
  moduleName?: string;
}
```

### `compileToWat(source): string`

Gibt nur den WAT-Text zurück (Debug).

## Unterstütztes TypeScript-Subset

| Feature | Beispiel |
|---------|----------|
| Arithmetik | `a + b`, `a * b`, `a / b`, `-x` |
| Vergleiche | `<`, `<=`, `>`, `>=`, `===`, `!==` |
| Logische Operatoren | `&&`, `\|\|`, `!` |
| Variablen | `let x: number = 10;`, `const y: number = 20;` |
| If/Else | `if (x > 0) { ... } else { ... }` |
| While-Loop | `while (i < n) { ... }` |
| For-Loop | `for (let i: number = 0; i < n; i = i + 1) { ... }` |
| Break/Continue | `break;`, `continue;` |
| Funktionen | Benannt, rekursiv, mehrere Exporte |
| Ternary | `x > 0 ? x : -x` |
| Math-Builtins | `Math.sqrt`, `Math.abs`, `Math.floor`, `Math.ceil`, `Math.min`, `Math.max`, `Math.PI` |
| Interfaces → Structs | `interface Point { x: number; y: number }` |
| Property-Zugriff | `p.x`, `p.y` |
| Objekt-Literale | `{ x: 1, y: 2 }` |
| console.log | Zahlen und Booleans via Host-Imports |
| Export | `export function ...` → Wasm Exports |

### Nicht unterstützt (Phase 1)

`var`, `eval`, `with`, Klassen, `async`/`await`, `try`/`catch`, Destructuring, Spread, Template Literals, Generics, Strings (Laufzeit), Arrays (Laufzeit).

## Architektur

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

## Projekt-Struktur

```
ts2wasm/
├── src/
│   ├── index.ts              # Public API: compile(), compileToWat()
│   ├── compiler.ts           # Pipeline: parse → check → codegen → emit
│   ├── checker/
│   │   ├── index.ts          # tsc-Integration mit In-Memory CompilerHost
│   │   └── type-mapper.ts    # ts.Type → WasmType Mapping
│   ├── ir/
│   │   ├── index.ts          # Re-exports
│   │   └── types.ts          # WasmModule, Function, Instruction, ValType
│   ├── codegen/
│   │   ├── index.ts          # Typed AST → IR Orchestrierung
│   │   ├── expressions.ts    # Expression → IR Instructions
│   │   ├── statements.ts     # Statement → IR Instructions
│   │   ├── functions.ts      # Funktionen (reserviert für Closures)
│   │   └── structs.ts        # Interface → GC Struct (reserviert)
│   ├── emit/
│   │   ├── binary.ts         # IR → Wasm Binary (Uint8Array)
│   │   ├── encoder.ts        # LEB128, Section-Encoding
│   │   ├── opcodes.ts        # Wasm-Opcodes inkl. GC (0xFB prefix)
│   │   └── wat.ts            # IR → WAT Text (Debug-Output)
│   └── runtime/
│       └── builtins.ts       # Runtime-Funktionen (reserviert)
├── playground/
│   ├── index.html            # Editor + WAT/Console/Errors
│   └── main.ts               # Compile & Run Logik
└── tests/
    ├── compiler.test.ts      # End-to-End: TS → Binary → Ausführung
    ├── binary.test.ts        # Binary-Encoder Unit Tests
    ├── codegen.test.ts       # Codegen Unit Tests
    └── fixtures/             # .ts Testdateien
```

## Codegen-Regeln

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

**void → kein Rückgabewert**

## Scripts

| Script | Beschreibung |
|--------|-------------|
| `pnpm build` | Library bauen (Vite) |
| `pnpm dev` | Playground Dev-Server |
| `pnpm test` | Tests ausführen (Vitest) |
| `pnpm test:watch` | Tests im Watch-Modus |
| `pnpm lint` | Linting (Biome) |
| `pnpm typecheck` | TypeScript prüfen |

## Toolchain

- **Sprache:** TypeScript (strict mode)
- **Parser & Type-Checker:** `typescript` Compiler API
- **Output:** `Uint8Array` (Wasm Binary) + WAT-Text
- **Package Manager:** pnpm
- **Bundler:** Vite
- **Test-Framework:** Vitest
- **Linting:** Biome

## Lizenz

MIT
