# Compiler Architecture

This document describes the ts2wasm compiler pipeline — how TypeScript source becomes a WasmGC binary.

## Pipeline Overview

```
                         ts2wasm Compiler Pipeline

  TypeScript       Parse &        Collect &       Emit         Optimize
   Source       Type-Check        Codegen        Binary        (optional)
     |              |                |              |              |
     v              v                v              v              v
 ┌────────┐   ┌──────────┐   ┌────────────┐   ┌────────┐   ┌──────────┐
 │ .ts/.js│──>│ checker/ │──>│  codegen/  │──>│  emit/ │──>│ optimize │
 │ source │   │ TypedAST │   │ WasmModule │   │ binary │   │ wasm-opt │
 └────────┘   └──────────┘   └────────────┘   └────────┘   └──────────┘
                   |                |
              TS compiler      3-pass:
              provides         1. collect imports
              types +          2. collect declarations
              diagnostics      3. compile bodies
```

Entry point: `compileSource()` in `src/compiler.ts`.

### Step 1: Parse & Type-Check (`src/checker/`)

Uses the TypeScript compiler API to parse source and run the type checker. Produces a `TypedAST` containing the AST (`ts.SourceFile`), the type checker (`ts.TypeChecker`), and diagnostics.

The compiler tolerates most type errors — it only aborts on hard syntax errors. This lets it compile JavaScript and loosely-typed TypeScript.

**Files:**
- `checker/index.ts` — `analyzeSource()`, `analyzeFiles()`, language service
- `checker/type-mapper.ts` — maps TS types to Wasm value types (`f64`, `i32`, `externref`, struct refs)

### Step 2: Codegen (`src/codegen/`)

Transforms the TypedAST into a `WasmModule` IR. This is the largest subsystem. It runs in three passes:

**Pass 1 — Collect imports.** Scans the source for features that need host imports (console, Math, string operations, extern classes). Registers import functions in the module.

**Pass 2 — Collect declarations.** Walks top-level statements to register all functions, classes, and interfaces. Allocates function indices, struct types, and global variables. Does not emit instruction bodies yet.

**Pass 3 — Compile bodies.** Walks each function body and emits Wasm instructions. This is where expressions and statements become `Instr[]` arrays.

After the three passes, several fixup and optimization passes run:
- `fixupStructNewArgCounts` — reconcile struct field counts with constructor args
- `peephole.ts` — remove redundant ops (e.g., `ref.as_non_null` after `ref.cast`)
- `stack-balance.ts` — ensure all branches have matching stack types
- `dead-elimination.ts` — remove unused imports and types

**Files:**

| File | Responsibility |
|------|---------------|
| `codegen/index.ts` | Module-level orchestration, collect/compile passes, fixups |
| `codegen/expressions.ts` | Expression codegen (binary ops, calls, member access, literals) |
| `codegen/statements.ts` | Statement codegen (if, for, while, switch, try/catch, return) |
| `codegen/type-coercion.ts` | Type conversions (f64 <-> i32, ref <-> externref, boxing) |
| `codegen/closures.ts` | Closure capture via ref cells |
| `codegen/functions.ts` | Function compilation, parameter handling, generators |
| `codegen/property-access.ts` | Property get/set on structs and extern objects |
| `codegen/string-ops.ts` | String method compilation |
| `codegen/array-methods.ts` | Array method compilation |
| `codegen/object-ops.ts` | Object.keys, Object.assign, spread, etc. |
| `codegen/literals.ts` | Object/array literal emission |
| `codegen/structs.ts` | Struct type creation and field management |
| `codegen/binary-ops.ts` | Binary/comparison operator helpers |
| `codegen/math-helpers.ts` | Inline Wasm for Math.* methods |
| `codegen/typeof-delete.ts` | `typeof` and `delete` operators |
| `codegen/peephole.ts` | Peephole optimization pass |
| `codegen/stack-balance.ts` | Stack type balancing for branches |
| `codegen/dead-elimination.ts` | Dead import/type elimination |
| `codegen/walk-instructions.ts` | Instruction tree walker utility |
| `codegen/context/` | `CodegenContext` and `FunctionContext` types and helpers |
| `codegen/registry/` | Type and import registration |

### Step 3: Emit Binary (`src/emit/`)

Serializes the `WasmModule` IR into a valid `.wasm` binary.

**Files:**
- `emit/binary.ts` — main binary emitter (section-by-section)
- `emit/encoder.ts` — `WasmEncoder` low-level byte writer (LEB128, etc.)
- `emit/opcodes.ts` — Wasm opcode constants
- `emit/wat.ts` — WAT text format emitter (for debugging)
- `emit/sourcemap.ts` — source map generation
- `emit/c-header.ts` — C header generation (linear memory target)

### Step 4: Optimize (optional, `src/optimize.ts`)

Runs Binaryen's `wasm-opt` on the binary for size/speed optimization. Enabled with `--optimize` / `-O`.

### Step 5: Link (multi-file, `src/link/`)

For multi-file compilation, links object modules into a single binary. Resolves cross-module references and merges type/function/global sections.

## IR: The WasmModule

The intermediate representation (`src/ir/types.ts`) is a direct model of a Wasm module:

```
WasmModule
  ├── types: TypeDef[]        — struct, array, func type definitions
  ├── imports: Import[]       — host function/global imports
  ├── functions: WasmFunction[] — function bodies (locals + Instr[])
  ├── globals: Global[]       — module-level globals
  ├── exports: Export[]       — exported functions/globals/memories
  ├── tables: Table[]         — function tables (for indirect calls)
  ├── elements: Element[]     — element segments (ref.func targets)
  ├── stringPool: string[]    — string literal pool
  └── ...
```

Instructions are a recursive tree: each `Instr` has an opcode and optional child instructions (for blocks, if/else, loops, etc.).

## Runtime & Host Imports (`src/runtime.ts`)

The compiler operates in two modes:

- **JS host mode** (default): imports helper functions from a JS runtime for operations that are expensive or impossible in pure Wasm (e.g., `console.log`, regex, `typeof` checks on externref). `src/runtime.ts` provides `buildImports()` which creates the import object.
- **Standalone/WASI mode** (`--target wasi`): uses only WASI imports (`fd_write`, `proc_exit`) and native Wasm implementations. No JS runtime needed.

New features should have Wasm-native implementations. Host imports are acceptable as a fast path but must have a standalone fallback.

## Key Patterns

### CodegenContext and FunctionContext

`CodegenContext` (`codegen/context/types.ts`) is the global compilation state — the module being built, type registry, function map, import tracking. It is created once per compilation.

`FunctionContext` is per-function state — local variables, the instruction body being built, label stack, closure info. A new one is pushed for each function/method/lambda.

### VOID_RESULT Sentinel

Expression compilation returns `InnerResult = ValType | null | typeof VOID_RESULT`. Most expressions produce a value (`"f64"`, `"i32"`, `"ref ..."`). Statements-as-expressions return `VOID_RESULT` to indicate "no value on the stack." `null` means "value is externref."

### Ref Cells for Closures

Mutable variables captured by closures are wrapped in a ref cell — a single-field struct:
```wat
(type $ref_cell_f64 (struct (field $value (mut f64))))
```
The outer function and the closure both hold a reference to the same cell, so mutations are visible to both.

### addUnionImports and Index Shifting

When union types are encountered during compilation, new host imports may be added late. Since import functions occupy the first indices in the Wasm function index space, adding an import shifts all local function indices. `flushLateImportShifts()` patches existing `call` instructions to account for the shift.

### Extern Classes

TypeScript `declare class` declarations describe JS objects the Wasm module interacts with via `externref`. The compiler generates host imports for construction, method calls, and property access. In standalone mode, these are unavailable — the compiler emits struct-based alternatives where possible.

## Where Do I Add X?

| I want to... | Look at... |
|--------------|-----------|
| Support a new expression type | `codegen/expressions.ts` — add a case to `compileExpression()` |
| Support a new statement type | `codegen/statements.ts` — add a case to `compileStatement()` |
| Add a new binary/comparison operator | `codegen/binary-ops.ts` |
| Add a built-in method (e.g., `Array.from`) | `codegen/array-methods.ts` or `codegen/string-ops.ts` |
| Add a host import | `codegen/index.ts` (collection pass) + `src/runtime.ts` (JS impl) |
| Add a new type coercion | `codegen/type-coercion.ts` — `coerceType()` |
| Change how closures capture variables | `codegen/closures.ts` |
| Fix a Wasm binary encoding bug | `emit/binary.ts` or `emit/encoder.ts` |
| Add a new Wasm opcode | `emit/opcodes.ts` + `src/ir/types.ts` (Instr union) |
| Add a CLI flag | `src/cli.ts` + `src/index.ts` (CompileOptions) |
| Add a peephole optimization | `codegen/peephole.ts` |

## How a Function Gets Compiled

Here is a simplified walkthrough of compiling:

```typescript
function add(a: number, b: number): number {
  return a + b;
}
```

**1. Type-check** — TS checker infers parameter types as `number`, return type `number`.

**2. Collect** (`collectDeclarations`) — registers a function named `"add"` with type signature `(f64, f64) -> f64`. Allocates a function index and creates an empty `WasmFunction`.

**3. Compile body** (`compileDeclarations` -> `compileFunction`) — pushes a `FunctionContext`, walks the function body:

- `compileStatement(ReturnStatement)` encounters `return a + b`
- `compileExpression(BinaryExpression)` encounters `a + b`
  - `compileExpression(Identifier "a")` -> emits `local.get 0`
  - `compileExpression(Identifier "b")` -> emits `local.get 1`
  - Sees `+` with two `f64` operands -> emits `f64.add`
- Return statement wraps with implicit return

**4. Result** — the function's instruction body is:
```wat
(func $add (param f64 f64) (result f64)
  local.get 0    ;; a
  local.get 1    ;; b
  f64.add
)
```

**5. Emit** — the binary emitter writes this as bytes in the code section of the `.wasm` file.

## Testing

- **Equivalence tests** (`tests/equivalence.test.ts`): compile TS snippets, run in both Node.js and Wasm, compare outputs. The primary correctness test.
- **Test262** (`tests/test262.test.ts`): ECMAScript conformance suite. Tracks pass/fail counts as a dashboard — tests don't assert, so vitest always passes.
- **Issue-specific tests** (`tests/issue-*.test.ts`): regression tests for specific bugs.

## Related Work

js2wasm occupies a specific niche in the JS-to-Wasm landscape. There are four major approaches:

| Approach | Example | Strategy | Module size | Spec coverage |
|---|---|---|---|---|
| Bundled engine + AOT specialization | StarlingMonkey / weval | SpiderMonkey in Wasm, partially evaluated against fixed bytecode | ~8 MB | ~100% |
| **Direct AOT to Wasm GC** | **js2wasm** | **TS/JS → WasmGC structs/arrays directly, no bundled engine** | **KB range** | **~42%** |
| Interpreter-only bundling | Javy / QuickJS | QuickJS compiled to Wasm, JS interpreted at runtime | ~869 KB | ~99% |
| Direct AOT to core Wasm | Porffor | JS → linear memory Wasm, no GC types | KB range | ~50% |

**js2wasm's position**: the only approach using the Wasm GC proposal for direct compilation. This means the host runtime manages GC natively — no custom allocator, no bundled engine — at the cost of requiring a GC-capable runtime (Chrome 119+, Firefox 120+, wasmtime 14+).

The StarlingMonkey/weval approach (by the Bytecode Alliance) is technically closest in goal but architecturally opposite: it achieves near-100% spec coverage by bundling SpiderMonkey and specializing it via partial evaluation (the first Futamura projection). The three-part blog series by Chris Fallin is the best public description of that architecture:

- [Part 1: Portable Baseline Interpreter](https://cfallin.org/blog/2023/10/11/spidermonkey-pbl/) (Oct 2023)
- [Part 2: AOT JS Compilation](https://cfallin.org/blog/2024/08/27/aot-js/) (Aug 2024)
- [Part 3: weval / Partial Evaluation](https://cfallin.org/blog/2024/08/28/weval/) (Aug 2024)

For a full technical comparison, see [docs/competitive-analysis.md](./competitive-analysis.md).
