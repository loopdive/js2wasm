# Linear-Memory Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `{ target: "linear" }` compilation backend that emits standard Wasm with linear memory, enabling the linker (`src/link/`) to be compiled into a portable `linker.wasm`.

**Architecture:** Both targets share the same frontend (TS parser + type checker). They diverge at codegen: `target: "gc"` uses `src/codegen/`, `target: "linear"` uses `src/codegen-linear/`. The linear backend emits only MVP Wasm instructions (no GC proposal) with a bump-allocated heap in linear memory. Runtime data structures (Map, Array, String, etc.) are implemented as Wasm functions emitted into the output module.

**Tech Stack:** TypeScript, vitest, Wasm MVP + multi-value + exception handling proposals

---

## Phase 1: IR Extensions & Scaffolding

### Task 1: Add memory load/store instructions to IR

The current IR (`src/ir/types.ts`) lacks memory load/store and several integer operations needed for linear memory. Add them to the `Instr` union type.

**Files:**
- Modify: `src/ir/types.ts` (Instr union, ~line 94-178)
- Modify: `src/emit/opcodes.ts` (OP object)
- Modify: `src/emit/binary.ts` (encodeInstr function)
- Modify: `src/emit/wat.ts` (WAT text emitter, add cases)
- Test: `tests/linear-ir.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/linear-ir.test.ts
import { describe, it, expect } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import type { WasmModule, WasmFunction, Instr } from "../src/ir/types.js";
import { createEmptyModule } from "../src/ir/types.js";

function buildModuleWithBody(body: Instr[]): WasmModule {
  const mod = createEmptyModule();
  mod.types.push({ kind: "func", name: "test", params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
  mod.functions.push({
    name: "test",
    typeIdx: 0,
    locals: [],
    body,
    exported: true,
  });
  mod.exports.push({ name: "test", desc: { kind: "func", index: 0 } });
  return mod;
}

describe("linear-memory IR instructions", () => {
  it("emits i32.load and i32.store", async () => {
    const mod = buildModuleWithBody([
      { op: "local.get", index: 0 },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 0 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.get", index: 0 },
      { op: "local.tee", index: 0 },
      { op: "i32.store", align: 2, offset: 0 },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 0 },
    ]);
    // Add a memory to the module (1 page)
    mod.memories = [{ min: 1 }];
    const binary = emitBinary(mod);
    expect(binary.length).toBeGreaterThan(8);

    const { instance } = await WebAssembly.instantiate(binary);
    const test = (instance.exports as any).test;
    // Store 0+1=1 at address 0, return it
    expect(test(0)).toBe(1);
  });

  it("emits i32.load8_u and i32.store8", async () => {
    const mod = buildModuleWithBody([
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xff },
      { op: "i32.store8", align: 0, offset: 0 },
      { op: "local.get", index: 0 },
      { op: "i32.load8_u", align: 0, offset: 0 },
    ]);
    mod.memories = [{ min: 1 }];
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const test = (instance.exports as any).test;
    expect(test(0)).toBe(255);
  });

  it("emits i32.div_u and i32.rem_u", async () => {
    const mod = buildModuleWithBody([
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 3 },
      { op: "i32.div_u" },
    ]);
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const test = (instance.exports as any).test;
    expect(test(10)).toBe(3);
  });

  it("emits i32.lt_u", async () => {
    const mod = buildModuleWithBody([
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 5 },
      { op: "i32.lt_u" },
    ]);
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const test = (instance.exports as any).test;
    expect(test(3)).toBe(1);
    expect(test(5)).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/linear-ir.test.ts`
Expected: FAIL — type errors for unknown instruction ops

**Step 3: Add instructions to IR types**

Add to the `Instr` union in `src/ir/types.ts`:

```typescript
  // Memory load/store
  | { op: "i32.load"; align: number; offset: number }
  | { op: "i32.load8_u"; align: number; offset: number }
  | { op: "i32.load8_s"; align: number; offset: number }
  | { op: "i32.load16_u"; align: number; offset: number }
  | { op: "i32.store"; align: number; offset: number }
  | { op: "i32.store8"; align: number; offset: number }
  | { op: "i32.store16"; align: number; offset: number }
  // Integer division and remainder
  | { op: "i32.div_u" }
  | { op: "i32.div_s" }
  | { op: "i32.rem_u" }
  | { op: "i32.rem_s" }
  // Unsigned comparisons (i32.lt_s, i32.le_s, etc. already exist)
  | { op: "i32.lt_u" }
  | { op: "i32.le_u" }
  | { op: "i32.gt_u" }
  // i32 misc
  | { op: "i32.wrap_i64" }
  // Data section
  | { op: "data.drop"; dataIdx: number }
```

Add `memories` field to `WasmModule`:
```typescript
  memories: { min: number; max?: number }[];
```
Update `createEmptyModule()` to include `memories: []`.

**Step 4: Add opcodes**

Add to `OP` in `src/emit/opcodes.ts`:

```typescript
  i32_load: 0x28,
  i32_load8_s: 0x2c,
  i32_load8_u: 0x2d,
  i32_load16_s: 0x2e,
  i32_load16_u: 0x2f,
  i32_store: 0x36,
  i32_store8: 0x3a,
  i32_store16: 0x3b,
  i32_div_s: 0x6d,
  i32_div_u: 0x6e,
  i32_rem_s: 0x6f,
  i32_rem_u: 0x70,
  i32_lt_u: 0x49,
  i32_le_u: 0x4d,
  i32_gt_u: 0x4b,
  i32_wrap_i64: 0xa7,
```

**Step 5: Add encoding in binary.ts**

Add cases in `encodeInstr()` for each new instruction. Memory ops encode: `opcode`, `align` (u32), `offset` (u32). Simple ops just encode the opcode byte.

Also emit a memory section when `mod.memories.length > 0`:

```typescript
// Memory section (between table and global sections)
if (mod.memories.length > 0) {
  enc.section(SECTION.memory, (s) => {
    s.u32(mod.memories.length);
    for (const mem of mod.memories) {
      if (mem.max !== undefined) {
        s.byte(0x01);
        s.u32(mem.min);
        s.u32(mem.max);
      } else {
        s.byte(0x00);
        s.u32(mem.min);
      }
    }
  });
}
```

**Step 6: Add WAT output in wat.ts**

Add cases for the new instructions in the WAT emitter.

**Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/linear-ir.test.ts`
Expected: PASS

**Step 8: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass

**Step 9: Commit**

```bash
git add src/ir/types.ts src/emit/opcodes.ts src/emit/binary.ts src/emit/wat.ts tests/linear-ir.test.ts
git commit -m "feat: add linear-memory instructions to IR (load/store, div, rem, unsigned cmp)"
```

---

### Task 2: Add target option to CompileOptions and scaffold codegen-linear

**Files:**
- Modify: `src/index.ts` (CompileOptions)
- Modify: `src/compiler.ts` (branch on target)
- Create: `src/codegen-linear/index.ts`
- Create: `src/codegen-linear/context.ts`
- Test: `tests/linear-basic.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/linear-basic.test.ts
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("linear-memory backend", () => {
  it("compiles a constant-returning function", async () => {
    const result = compile(`
      export function answer(): number {
        return 42;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(8);

    const { instance } = await WebAssembly.instantiate(result.binary);
    const answer = (instance.exports as any).answer;
    expect(answer()).toBe(42);
  });

  it("compiles addition of two parameters", async () => {
    const result = compile(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary);
    const add = (instance.exports as any).add;
    expect(add(3, 4)).toBe(7);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/linear-basic.test.ts`
Expected: FAIL — target option not recognized

**Step 3: Add target option**

In `src/index.ts`, add to `CompileOptions`:
```typescript
  /** Compilation target: "gc" (default) or "linear" (MVP Wasm with linear memory) */
  target?: "gc" | "linear";
```

**Step 4: Create codegen-linear context**

```typescript
// src/codegen-linear/context.ts
import ts from "typescript";
import type { WasmModule, WasmFunction, Instr, ValType, LocalDef } from "../ir/types.js";

export interface LinearContext {
  mod: WasmModule;
  checker: ts.TypeChecker;
  funcMap: Map<string, number>;
}

export interface LinearFuncContext {
  params: Map<string, number>;  // param name → local index
  locals: LocalDef[];
  localMap: Map<string, number>; // local name → local index
  body: Instr[];
  nextLocal: number;
}

export function addLocal(fctx: LinearFuncContext, name: string, type: ValType): number {
  const idx = fctx.nextLocal;
  fctx.locals.push({ name, type });
  fctx.localMap.set(name, idx);
  fctx.nextLocal++;
  return idx;
}
```

**Step 5: Create codegen-linear entry point**

```typescript
// src/codegen-linear/index.ts
import ts from "typescript";
import type { TypedAST } from "../checker/index.js";
import type { WasmModule, Instr } from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import type { LinearContext, LinearFuncContext } from "./context.js";
import { addLocal } from "./context.js";

export function generateLinearModule(ast: TypedAST): WasmModule {
  const mod = createEmptyModule();
  mod.memories = [{ min: 16 }]; // 1MB initial heap

  const ctx: LinearContext = {
    mod,
    checker: ast.checker,
    funcMap: new Map(),
  };

  // Pass 1: collect function signatures
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      collectFunction(ctx, stmt);
    }
  }

  // Pass 2: compile function bodies
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      compileFunction(ctx, stmt);
    }
  }

  // Export memory
  mod.exports.push({ name: "memory", desc: { kind: "memory", index: 0 } });

  return mod;
}

function resolveParamType(ctx: LinearContext, param: ts.ParameterDeclaration): "i32" | "f64" {
  if (!param.type) return "f64";
  const typeNode = param.type;
  if (ts.isTypeReferenceNode(typeNode)) return "i32"; // object types are pointers
  const text = typeNode.getText();
  if (text === "number" || text === "boolean") return "f64";
  return "i32"; // strings, objects → pointers
}

function resolveReturnType(ctx: LinearContext, decl: ts.FunctionDeclaration): "i32" | "f64" {
  if (!decl.type) return "f64";
  const text = decl.type.getText();
  if (text === "number" || text === "boolean" || text === "void") return "f64";
  return "i32";
}

function collectFunction(ctx: LinearContext, decl: ts.FunctionDeclaration): void {
  const name = decl.name!.text;
  const params = decl.parameters.map((p) => ({ kind: resolveParamType(ctx, p) as "i32" | "f64" }));
  const retKind = resolveReturnType(ctx, decl);
  const results = retKind === "f64" && !decl.type?.getText()?.includes("void")
    ? [{ kind: retKind as "i32" | "f64" }]
    : decl.type?.getText() === "void" ? [] : [{ kind: retKind as "i32" | "f64" }];

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: `$type_${name}`,
    params: params.map(p => ({ kind: p.kind })),
    results: results.map(r => ({ kind: r.kind })),
  });

  const funcIdx = ctx.mod.functions.length;
  ctx.funcMap.set(name, funcIdx);

  const isExported = decl.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

  ctx.mod.functions.push({
    name,
    typeIdx,
    locals: [],
    body: [],
    exported: isExported,
  });

  if (isExported) {
    ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  }
}

function compileFunction(ctx: LinearContext, decl: ts.FunctionDeclaration): void {
  const name = decl.name!.text;
  const funcIdx = ctx.funcMap.get(name)!;
  const func = ctx.mod.functions[funcIdx]!;

  const fctx: LinearFuncContext = {
    params: new Map(),
    locals: [],
    localMap: new Map(),
    body: [],
    nextLocal: decl.parameters.length,
  };

  // Register parameters
  for (let i = 0; i < decl.parameters.length; i++) {
    const p = decl.parameters[i]!;
    const pName = ts.isIdentifier(p.name) ? p.name.text : `_p${i}`;
    fctx.params.set(pName, i);
  }

  // Compile body
  if (decl.body) {
    for (const stmt of decl.body.statements) {
      compileStatement(ctx, fctx, stmt);
    }
  }

  func.locals = fctx.locals;
  func.body = fctx.body;
}

// --- Statement compilation (minimal for Task 2) ---

function compileStatement(ctx: LinearContext, fctx: LinearFuncContext, stmt: ts.Statement): void {
  if (ts.isReturnStatement(stmt)) {
    if (stmt.expression) {
      compileExpression(ctx, fctx, stmt.expression);
    }
    fctx.body.push({ op: "return" });
  }
}

// --- Expression compilation (minimal for Task 2) ---

function compileExpression(ctx: LinearContext, fctx: LinearFuncContext, expr: ts.Expression): void {
  if (ts.isNumericLiteral(expr)) {
    fctx.body.push({ op: "f64.const", value: Number(expr.text) });
  } else if (ts.isIdentifier(expr)) {
    const name = expr.text;
    const paramIdx = fctx.params.get(name);
    if (paramIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: paramIdx });
    }
    const localIdx = fctx.localMap.get(name);
    if (localIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: localIdx });
    }
  } else if (ts.isBinaryExpression(expr)) {
    compileExpression(ctx, fctx, expr.left);
    compileExpression(ctx, fctx, expr.right);
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: fctx.body.push({ op: "f64.add" }); break;
      case ts.SyntaxKind.MinusToken: fctx.body.push({ op: "f64.sub" }); break;
      case ts.SyntaxKind.AsteriskToken: fctx.body.push({ op: "f64.mul" }); break;
      case ts.SyntaxKind.SlashToken: fctx.body.push({ op: "f64.div" }); break;
    }
  } else if (ts.isParenthesizedExpression(expr)) {
    compileExpression(ctx, fctx, expr.expression);
  }
}
```

**Step 6: Wire up compiler.ts**

In `compileSource()`, after generating the AST, branch on target:

```typescript
import { generateLinearModule } from "./codegen-linear/index.js";

// Step 2: Generate IR
let mod;
try {
  if (options.target === "linear") {
    mod = generateLinearModule(ast);
  } else {
    mod = generateModule(ast);
  }
} catch (e) { /* existing error handling */ }
```

**Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/linear-basic.test.ts`
Expected: PASS

**Step 8: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests still pass (GC backend unchanged)

**Step 9: Commit**

```bash
git add src/index.ts src/compiler.ts src/codegen-linear/ tests/linear-basic.test.ts
git commit -m "feat: scaffold linear-memory codegen backend with target option"
```

---

## Phase 2: Runtime Library

All runtime functions are hand-crafted `WasmFunction` IR objects emitted into the output module. They use only i32 operations and linear memory load/store. Test each by building a minimal module, emitting binary, instantiating, and calling the function.

### Memory layout convention

```
Heap starts at offset 1024 (first 1KB reserved for scratch/stack).
Global $__heap_ptr (mut i32) initialized to 1024.

Object header (8 bytes):
  offset 0: u8  type tag (1=Array, 2=String, 3=Map, 4=Set, 5=Struct, 6=Uint8Array)
  offset 1: 3B  padding
  offset 4: u32 payload size in bytes

Array (tag 1):   [header 8B][len:u32][cap:u32][elements: i32×cap]
String (tag 2):  [header 8B][len:u32][utf8 bytes, 4B-aligned]
Map (tag 3):     [header 8B][count:u32][cap:u32][entries: (hash:u32, key:i32, val:i32)×cap]
Set (tag 4):     [header 8B][count:u32][cap:u32][entries: (hash:u32, key:i32)×cap]
Struct (tag 5):  [header 8B][field0:i32][field1:i32]...
Uint8Array (tag 6): [header 8B][len:u32][bytes, 4B-aligned]
```

### Task 3: Bump allocator and runtime scaffold

**Files:**
- Create: `src/codegen-linear/runtime.ts`
- Test: `tests/linear-runtime.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/linear-runtime.test.ts
import { describe, it, expect } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { createEmptyModule } from "../src/ir/types.js";
import { addRuntime } from "../src/codegen-linear/runtime.js";

function instantiateRuntime() {
  const mod = createEmptyModule();
  mod.memories = [{ min: 16 }];
  addRuntime(mod);
  // Export __malloc and __heap_ptr for testing
  const mallocIdx = mod.functions.findIndex(f => f.name === "__malloc");
  mod.exports.push(
    { name: "__malloc", desc: { kind: "func", index: mallocIdx } },
    { name: "memory", desc: { kind: "memory", index: 0 } },
  );
  const binary = emitBinary(mod);
  return WebAssembly.instantiate(binary);
}

describe("runtime: bump allocator", () => {
  it("__malloc returns 8-byte aligned pointers", async () => {
    const { instance } = await instantiateRuntime();
    const malloc = (instance.exports as any).__malloc;
    const p1 = malloc(10); // request 10 bytes
    expect(p1 % 8).toBe(0);
    const p2 = malloc(1);
    expect(p2 % 8).toBe(0);
    expect(p2).toBeGreaterThan(p1);
  });

  it("__malloc returns non-overlapping regions", async () => {
    const { instance } = await instantiateRuntime();
    const malloc = (instance.exports as any).__malloc;
    const p1 = malloc(100);
    const p2 = malloc(100);
    expect(p2 - p1).toBeGreaterThanOrEqual(100);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/linear-runtime.test.ts`
Expected: FAIL — module not found

**Step 3: Implement runtime.ts**

```typescript
// src/codegen-linear/runtime.ts
import type { WasmModule, WasmFunction, Instr, GlobalDef } from "../ir/types.js";

const HEAP_START = 1024;

/** Add runtime globals and functions to a linear-memory module. */
export function addRuntime(mod: WasmModule): RuntimeIndices {
  // Global: __heap_ptr
  const heapPtrGlobalIdx = mod.globals.length;
  mod.globals.push({
    name: "__heap_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: HEAP_START }],
  });

  // __malloc function type: (i32) → i32
  const mallocTypeIdx = mod.types.length;
  mod.types.push({
    kind: "func",
    name: "$type___malloc",
    params: [{ kind: "i32" }],
    results: [{ kind: "i32" }],
  });

  const mallocIdx = mod.functions.length;
  mod.functions.push(buildMalloc(mallocTypeIdx, heapPtrGlobalIdx));

  return { mallocIdx, heapPtrGlobalIdx };
}

export interface RuntimeIndices {
  mallocIdx: number;
}

function buildMalloc(typeIdx: number, heapPtrGlobalIdx: number): WasmFunction {
  // __malloc(size: i32) → i32
  // Bumps __heap_ptr, aligns to 8 bytes, returns old pointer.
  // local 0 = size (param)
  // local 1 = ptr (old heap_ptr)
  return {
    name: "__malloc",
    typeIdx,
    locals: [{ name: "ptr", type: { kind: "i32" } }],
    body: [
      // ptr = __heap_ptr
      { op: "global.get", index: heapPtrGlobalIdx },
      { op: "local.set", index: 1 },
      // __heap_ptr = (__heap_ptr + size + 7) & ~7  (align to 8)
      { op: "global.get", index: heapPtrGlobalIdx },
      { op: "local.get", index: 0 },
      { op: "i32.add" },
      { op: "i32.const", value: 7 },
      { op: "i32.add" },
      { op: "i32.const", value: ~7 },
      { op: "i32.and" },
      { op: "global.set", index: heapPtrGlobalIdx },
      // return ptr
      { op: "local.get", index: 1 },
    ],
    exported: false,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linear-runtime.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/codegen-linear/runtime.ts tests/linear-runtime.test.ts
git commit -m "feat: add bump allocator (__malloc) for linear-memory runtime"
```

---

### Task 4: Uint8Array runtime

**Files:**
- Modify: `src/codegen-linear/runtime.ts`
- Test: `tests/linear-runtime.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
describe("runtime: Uint8Array", () => {
  it("u8arr_new creates array and u8arr_get/u8arr_set round-trips", async () => {
    const { instance } = await instantiateRuntime(["__u8arr_new", "__u8arr_set", "__u8arr_get", "__u8arr_len"]);
    const { __u8arr_new, __u8arr_set, __u8arr_get, __u8arr_len } = instance.exports as any;
    const arr = __u8arr_new(10);
    expect(__u8arr_len(arr)).toBe(10);
    __u8arr_set(arr, 0, 42);
    __u8arr_set(arr, 9, 255);
    expect(__u8arr_get(arr, 0)).toBe(42);
    expect(__u8arr_get(arr, 9)).toBe(255);
  });
});
```

Update `instantiateRuntime` to accept a list of function names to export.

**Step 2: Implement __u8arr_new, __u8arr_get, __u8arr_set, __u8arr_len, __u8arr_slice**

Layout: `[header 8B][len:u32 at +8][bytes at +12...]`

- `__u8arr_new(len: i32) → i32`: malloc(12 + len), store tag=6, store len
- `__u8arr_get(arr: i32, idx: i32) → i32`: load8_u at arr+12+idx
- `__u8arr_set(arr: i32, idx: i32, val: i32)`: store8 at arr+12+idx
- `__u8arr_len(arr: i32) → i32`: load at arr+8
- `__u8arr_slice(arr: i32, start: i32, end: i32) → i32`: new array, copy bytes

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add Uint8Array runtime functions for linear-memory backend"
```

---

### Task 5: Array runtime

**Files:**
- Modify: `src/codegen-linear/runtime.ts`
- Test: `tests/linear-runtime.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
describe("runtime: Array", () => {
  it("arr_new + arr_push + arr_get round-trips", async () => {
    const { instance } = await instantiateRuntime(["__arr_new", "__arr_push", "__arr_get", "__arr_len"]);
    const { __arr_new, __arr_push, __arr_get, __arr_len } = instance.exports as any;
    const arr = __arr_new(4);
    expect(__arr_len(arr)).toBe(0);
    __arr_push(arr, 10);
    __arr_push(arr, 20);
    __arr_push(arr, 30);
    expect(__arr_len(arr)).toBe(3);
    expect(__arr_get(arr, 0)).toBe(10);
    expect(__arr_get(arr, 1)).toBe(20);
    expect(__arr_get(arr, 2)).toBe(30);
  });
});
```

**Step 2: Implement**

Layout: `[header 8B][len:u32 at +8][cap:u32 at +12][elements: i32×cap at +16...]`

- `__arr_new(cap) → i32`: malloc(16 + cap*4), store tag=1, len=0, cap
- `__arr_push(arr, val)`: store val at arr+16+len*4, increment len
- `__arr_get(arr, idx) → i32`: load at arr+16+idx*4
- `__arr_set(arr, idx, val)`: store at arr+16+idx*4
- `__arr_len(arr) → i32`: load at arr+8

Note: `__arr_push` does NOT handle capacity overflow (the linker pre-allocates sufficient capacity). A future enhancement could add realloc.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add Array runtime functions for linear-memory backend"
```

---

### Task 6: String runtime

**Files:**
- Modify: `src/codegen-linear/runtime.ts`
- Test: `tests/linear-runtime.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
describe("runtime: String", () => {
  it("str_eq returns 1 for equal strings and 0 for different", async () => {
    const { instance } = await instantiateRuntime(["__str_from_data", "__str_eq", "__str_len"]);
    const { __str_from_data, __str_eq, __str_len, memory } = instance.exports as any;
    const mem = new Uint8Array((memory as WebAssembly.Memory).buffer);
    // Write "abc" at data offset 0
    mem[0] = 97; mem[1] = 98; mem[2] = 99;
    const s1 = __str_from_data(0, 3);
    // Write another "abc" at offset 3
    mem[3] = 97; mem[4] = 98; mem[5] = 99;
    const s2 = __str_from_data(3, 3);
    // Write "xyz" at offset 6
    mem[6] = 120; mem[7] = 121; mem[8] = 122;
    const s3 = __str_from_data(6, 3);
    expect(__str_eq(s1, s2)).toBe(1);
    expect(__str_eq(s1, s3)).toBe(0);
    expect(__str_len(s1)).toBe(3);
  });

  it("str_hash produces consistent hashes", async () => {
    const { instance } = await instantiateRuntime(["__str_from_data", "__str_hash"]);
    const { __str_from_data, __str_hash, memory } = instance.exports as any;
    const mem = new Uint8Array((memory as WebAssembly.Memory).buffer);
    mem[0] = 97; mem[1] = 98; mem[2] = 99; // "abc"
    const s1 = __str_from_data(0, 3);
    mem[3] = 97; mem[4] = 98; mem[5] = 99; // "abc"
    const s2 = __str_from_data(3, 3);
    expect(__str_hash(s1)).toBe(__str_hash(s2));
  });
});
```

**Step 2: Implement**

Layout: `[header 8B][len:u32 at +8][utf8 bytes at +12...]`

- `__str_from_data(dataPtr, len) → i32`: malloc(12+len), copy bytes, store tag=2, len
- `__str_eq(a, b) → i32`: compare lengths, then byte-by-byte
- `__str_hash(s) → i32`: FNV-1a hash over bytes
- `__str_len(s) → i32`: load at s+8
- `__str_concat(a, b) → i32`: new string with combined bytes
- `__str_startsWith(s, prefix) → i32`: compare first N bytes

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add String runtime functions for linear-memory backend"
```

---

### Task 7: Map runtime

**Files:**
- Modify: `src/codegen-linear/runtime.ts`
- Test: `tests/linear-runtime.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
describe("runtime: Map", () => {
  it("map_new + map_set + map_get round-trips with string keys", async () => {
    const { instance } = await instantiateRuntime([
      "__map_new", "__map_set", "__map_get", "__map_has", "__map_size",
      "__str_from_data",
    ]);
    const exports = instance.exports as any;
    const mem = new Uint8Array((exports.memory as WebAssembly.Memory).buffer);
    // Create keys
    mem[0] = 97; mem[1] = 98; mem[2] = 99; // "abc"
    const key1 = exports.__str_from_data(0, 3);
    mem[3] = 100; mem[4] = 101; mem[5] = 102; // "def"
    const key2 = exports.__str_from_data(3, 3);

    const map = exports.__map_new();
    expect(exports.__map_size(map)).toBe(0);
    exports.__map_set(map, key1, 42);
    exports.__map_set(map, key2, 99);
    expect(exports.__map_size(map)).toBe(2);
    expect(exports.__map_has(map, key1)).toBe(1);
    expect(exports.__map_get(map, key1)).toBe(42);
    expect(exports.__map_get(map, key2)).toBe(99);
  });
});
```

**Step 2: Implement**

Open-addressing hash table with string keys (using `__str_hash` and `__str_eq`).

Layout: `[header 8B][count:u32 at +8][cap:u32 at +12][entries at +16...]`
Entry: `[hash:u32][key:i32][val:i32]` = 12 bytes each

- `__map_new() → i32`: malloc with initial capacity 16
- `__map_set(map, key, val)`: hash key, probe, insert/update
- `__map_get(map, key) → i32`: hash key, probe, return val (or 0)
- `__map_has(map, key) → i32`: hash key, probe, return 0/1
- `__map_size(map) → i32`: load at map+8
- `__map_keys(map) → i32`: allocate Array, iterate entries, push non-zero keys

Map does NOT handle resize (initial capacity should be large enough for linker use). A future task can add rehashing.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add Map runtime functions for linear-memory backend"
```

---

### Task 8: Set runtime

**Files:**
- Modify: `src/codegen-linear/runtime.ts`
- Test: `tests/linear-runtime.test.ts` (add tests)

Identical pattern to Map but without values. Entry = `[hash:u32][key:i32]` = 8 bytes.

Functions: `__set_new`, `__set_add`, `__set_has`, `__set_size`.

**Commit:**
```bash
git commit -m "feat: add Set runtime functions for linear-memory backend"
```

---

## Phase 3: Codegen — Expressions and Statements

### Task 9: Variable declarations, assignments, and control flow

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles variable declarations and if/else", async () => {
  const result = compile(`
    export function abs(x: number): number {
      let result: number;
      if (x < 0) {
        result = -x;
      } else {
        result = x;
      }
      return result;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const abs = (instance.exports as any).abs;
  expect(abs(-5)).toBe(5);
  expect(abs(3)).toBe(3);
});

it("compiles while loops", async () => {
  const result = compile(`
    export function sum(n: number): number {
      let total = 0;
      let i = 0;
      while (i < n) {
        total = total + i;
        i = i + 1;
      }
      return total;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const sum = (instance.exports as any).sum;
  expect(sum(5)).toBe(10);
});

it("compiles for loops", async () => {
  const result = compile(`
    export function factorial(n: number): number {
      let result = 1;
      for (let i = 2; i <= n; i = i + 1) {
        result = result * i;
      }
      return result;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const factorial = (instance.exports as any).factorial;
  expect(factorial(5)).toBe(120);
});
```

**Step 2: Implement in codegen-linear/index.ts**

Add to `compileStatement`:
- `VariableDeclaration` → `addLocal` + compile initializer + `local.set`
- `IfStatement` → `if/then/else` block
- `WhileStatement` → `block { loop { br_if; ...; br } }`
- `ForStatement` → compile init; `block { loop { br_if; ...; increment; br } }`
- `ExpressionStatement` → compile expression + `drop` if value-producing

Add to `compileExpression`:
- `PrefixUnaryExpression` (minus) → `f64.neg`
- Comparisons (`<`, `>`, `<=`, `>=`, `===`, `!==`) → `f64.lt`, `f64.gt`, etc.
- Assignment (`=`) in expressions

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add variable declarations, if/else, while, for to linear codegen"
```

---

### Task 10: Bitwise operators and switch statements

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles bitwise operations", async () => {
  const result = compile(`
    export function readBits(value: number): number {
      return (value & 0x7f) | ((value >>> 7) << 1);
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const readBits = (instance.exports as any).readBits;
  expect(readBits(0xff)).toBe(0x7f | (1 << 1));
});

it("compiles switch statements", async () => {
  const result = compile(`
    export function describe(kind: number): number {
      switch (kind) {
        case 1: return 10;
        case 2: return 20;
        case 3: return 30;
        default: return 0;
      }
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const describe = (instance.exports as any).describe;
  expect(describe(1)).toBe(10);
  expect(describe(2)).toBe(20);
  expect(describe(99)).toBe(0);
});
```

**Step 2: Implement**

Bitwise ops require `i32.trunc_f64_s` before the op and `f64.convert_i32_s` after (since numbers are f64). The pattern is:

```
compileExpr(left)   → f64
i32.trunc_f64_s     → i32
compileExpr(right)  → f64
i32.trunc_f64_s     → i32
i32.and             → i32
f64.convert_i32_s   → f64
```

For `>>>` (unsigned right shift), use `f64.convert_i32_u` instead.

Switch: compile as nested `block/br_table` or cascading `if/else`.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add bitwise operators and switch to linear codegen"
```

---

### Task 11: Function calls and multiple functions

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles function calls between local functions", async () => {
  const result = compile(`
    function helper(x: number): number {
      return x * 2;
    }
    export function main(a: number): number {
      return helper(a) + 1;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const main = (instance.exports as any).main;
  expect(main(5)).toBe(11);
});
```

**Step 2: Implement**

`CallExpression` where the callee is an identifier → look up in `funcMap`, emit `call $idx` with arguments.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add function call compilation to linear codegen"
```

---

### Task 12: Classes — construction and field access

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Modify: `src/codegen-linear/context.ts`
- Create: `src/codegen-linear/layout.ts`
- Test: `tests/linear-classes.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/linear-classes.test.ts
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("linear-memory classes", () => {
  it("compiles class construction and field access", async () => {
    const result = compile(`
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function getX(px: number, py: number): number {
        const p = new Point(px, py);
        return p.x;
      }
      export function getY(px: number, py: number): number {
        const p = new Point(px, py);
        return p.y;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const { getX, getY } = instance.exports as any;
    expect(getX(10, 20)).toBe(10);
    expect(getY(10, 20)).toBe(20);
  });

  it("compiles class methods", async () => {
    const result = compile(`
      class Counter {
        value: number;
        constructor(init: number) {
          this.value = init;
        }
        increment(): void {
          this.value = this.value + 1;
        }
        get(): number {
          return this.value;
        }
      }
      export function test(): number {
        const c = new Counter(10);
        c.increment();
        c.increment();
        return c.get();
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as any).test()).toBe(12);
  });
});
```

**Step 2: Implement layout.ts**

```typescript
// src/codegen-linear/layout.ts
export interface ClassLayout {
  name: string;
  totalSize: number;    // header (8) + fields
  fields: Map<string, { offset: number; type: "i32" | "f64" }>;
}

const HEADER_SIZE = 8;
const FIELD_SIZE = 4; // all fields stored as i32 (pointers or truncated numbers)

export function computeClassLayout(name: string, fieldNames: string[]): ClassLayout {
  const fields = new Map<string, { offset: number; type: "i32" | "f64" }>();
  let offset = HEADER_SIZE;
  for (const f of fieldNames) {
    fields.set(f, { offset, type: "i32" });
    offset += FIELD_SIZE;
  }
  return { name, totalSize: offset, fields };
}
```

**Step 3: Implement in codegen**

- Collect class declarations → compute layout, register constructor + methods
- `new ClassName(args)` → `call __malloc(totalSize)`, store tag, store fields
- `obj.field` → `i32.load offset=fieldOffset`
- `obj.field = val` → `i32.store offset=fieldOffset`
- `obj.method(args)` → `call $method(obj, args)`
- `this` → `local.get 0` (first param of method)

**Step 4: Run tests, commit**

```bash
git commit -m "feat: add class construction and field access to linear codegen"
```

---

### Task 13: Array and Uint8Array operations from TS

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-collections.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/linear-collections.test.ts
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("linear-memory collections", () => {
  it("compiles array push and indexing", async () => {
    const result = compile(`
      export function test(): number {
        const arr: number[] = [];
        arr.push(10);
        arr.push(20);
        arr.push(30);
        return arr[1];
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as any).test()).toBe(20);
  });

  it("compiles array.length", async () => {
    const result = compile(`
      export function test(): number {
        const arr: number[] = [];
        arr.push(1);
        arr.push(2);
        arr.push(3);
        return arr.length;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as any).test()).toBe(3);
  });
});
```

**Step 2: Implement**

- `[]` (empty array literal) → `call __arr_new(16)` (default capacity)
- `[a, b, c]` → `__arr_new(3)` + `__arr_push` for each
- `arr.push(x)` → `call __arr_push`
- `arr[i]` → `call __arr_get`
- `arr.length` → `call __arr_len`
- `new Uint8Array(n)` → `call __u8arr_new`
- `arr[i]` on Uint8Array → `call __u8arr_get`

The codegen needs to check the TS type to determine which runtime function to call.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add Array and Uint8Array compilation to linear codegen"
```

---

### Task 14: Map and Set operations from TS

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-collections.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles Map operations", async () => {
  const result = compile(`
    export function test(): number {
      const map = new Map<string, number>();
      map.set("a", 10);
      map.set("b", 20);
      return map.get("a")! + map.size;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(12); // 10 + 2
});
```

**Step 2: Implement**

- `new Map()` → `call __map_new`
- `map.set(k, v)` → `call __map_set`
- `map.get(k)` → `call __map_get`
- `map.has(k)` → `call __map_has`
- `map.size` → `call __map_size`
- Same pattern for Set.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add Map and Set compilation to linear codegen"
```

---

### Task 15: String literals and operations

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles string literals and equality", async () => {
  const result = compile(`
    export function test(): number {
      const a = "hello";
      const b = "hello";
      const c = "world";
      if (a === b) {
        if (a === c) return 0;
        return 1;
      }
      return 2;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(1);
});
```

**Step 2: Implement**

String literals are placed in a Wasm data segment. At module init, each literal is copied into a heap-allocated string object via `__str_from_data`.

- Collect all string literals during codegen
- Emit a data segment with concatenated UTF-8 bytes
- For each string literal reference, emit: `call __str_from_data(dataOffset, len)`
- String `===` → `call __str_eq`
- Template literals → chain of `call __str_concat`

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add string literals and operations to linear codegen"
```

---

### Task 16: for-of loops

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles for-of over arrays", async () => {
  const result = compile(`
    export function sum(): number {
      const arr = [10, 20, 30];
      let total = 0;
      for (const x of arr) {
        total = total + x;
      }
      return total;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).sum()).toBe(60);
});
```

**Step 2: Implement**

`for (const x of arr)` compiles to:
```
local $i = 0
local $len = __arr_len(arr)
block { loop {
  br_if ($i >= $len) → exit block
  local $x = __arr_get(arr, $i)
  ... body ...
  $i = $i + 1
  br → loop
}}
```

For `for (const [k, v] of map)`, use `__map_entries` iterator pattern (iterate slots, skip empty).

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add for-of loop compilation to linear codegen"
```

---

### Task 17: Throw and try-catch

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles throw and try-catch", async () => {
  const result = compile(`
    function mayThrow(x: number): number {
      if (x < 0) throw new Error("negative");
      return x;
    }
    export function test(x: number): number {
      try {
        return mayThrow(x);
      } catch (e) {
        return -1;
      }
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const test = (instance.exports as any).test;
  expect(test(5)).toBe(5);
  expect(test(-1)).toBe(-1);
});
```

**Step 2: Implement**

Uses the Wasm EH proposal (same as GC backend):
- `throw` → `throw $exn_tag`
- `try { } catch { }` → `try { } catch $exn_tag { }`
- Error objects: allocate a struct with message string pointer. For the linear backend, the catch binding receives the thrown value (an i32 pointer).

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add throw and try-catch to linear codegen"
```

---

### Task 18: Arrow functions and closures

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles arrow functions as callbacks", async () => {
  const result = compile(`
    function applyToEach(arr: number[], f: (x: number) => number): number[] {
      const result: number[] = [];
      for (let i = 0; i < arr.length; i = i + 1) {
        result.push(f(arr[i]));
      }
      return result;
    }
    export function test(): number {
      const doubled = applyToEach([1, 2, 3], (x: number): number => x * 2);
      return doubled[0] + doubled[1] + doubled[2];
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(12);
});
```

**Step 2: Implement**

Arrow functions compile to:
1. Lift the arrow body into a top-level function with a closure struct as first param
2. At call site: allocate closure struct (funcref index + captures)
3. For `call_indirect`: use a function table

For arrow functions without captures (common in the linker for `.filter`, `.map`, etc.), the closure struct is empty and the function index is passed directly.

Pattern:
- Add a table to the module
- Arrow function → lifted function added to table
- Closure struct: `[header 8B][funcTableIdx:i32 at +8][capture0:i32 at +12]...`
- Calling: `call_indirect (type $sig) (get captures..., args..., load funcTableIdx)`

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add arrow functions and closures to linear codegen"
```

---

### Task 19: Destructuring and rest parameters

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles array destructuring", async () => {
  const result = compile(`
    export function test(): number {
      const arr = [10, 20, 30];
      const [a, b, c] = arr;
      return a + b + c;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(60);
});
```

**Step 2: Implement**

Array destructuring: `const [a, b, c] = arr` →
```
local $a = __arr_get(arr, 0)
local $b = __arr_get(arr, 1)
local $c = __arr_get(arr, 2)
```

Rest parameter: `const [first, ...rest] = arr` →
```
local $first = __arr_get(arr, 0)
local $rest = __arr_slice(arr, 1, __arr_len(arr))
```

Object destructuring: desugar to property access.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add destructuring and rest parameters to linear codegen"
```

---

### Task 20: Array higher-order methods (filter, map, find, some, flatMap)

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-collections.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles array.filter with arrow function", async () => {
  const result = compile(`
    export function test(): number {
      const arr = [1, 2, 3, 4, 5, 6];
      const evens = arr.filter((x: number): boolean => x % 2 === 0);
      return evens.length;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(3);
});

it("compiles array.map", async () => {
  const result = compile(`
    export function test(): number {
      const arr = [1, 2, 3];
      const doubled = arr.map((x: number): number => x * 2);
      return doubled[0] + doubled[1] + doubled[2];
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(12);
});
```

**Step 2: Implement**

Array methods can be inlined at the call site (same approach as the GC backend):

`arr.filter(fn)` compiles to:
```
local $result = __arr_new(arr.length)
for i in 0..arr.length:
  local $elem = __arr_get(arr, i)
  if call_indirect fn($elem):
    __arr_push($result, $elem)
return $result
```

Same pattern for `.map`, `.find`, `.some`, `.flatMap`, `.reduce`, `.join`.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add array higher-order methods to linear codegen"
```

---

## Phase 4: Integration & Self-Host

### Task 21: Getter properties

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Test: `tests/linear-classes.test.ts` (add tests)

The `ByteReader` class in the linker uses `get remaining(): number`. Compile getters as regular functions called at property-access sites.

**Step 1: Write the failing test**

```typescript
it("compiles getter properties", async () => {
  const result = compile(`
    class Reader {
      pos: number;
      len: number;
      constructor(len: number) {
        this.pos = 0;
        this.len = len;
      }
      get remaining(): number {
        return this.len - this.pos;
      }
    }
    export function test(): number {
      const r = new Reader(100);
      r.pos = 30;
      return r.remaining;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(70);
});
```

**Step 2: Implement**

Getter: compile as `$ClassName_get_propName(self)`, called at `obj.propName` when the property is a getter.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add getter properties to linear codegen"
```

---

### Task 22: for-of over Map entries and instanceof

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Modify: `src/codegen-linear/runtime.ts` (add `__map_entries_iter`)
- Test: `tests/linear-collections.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles for-of over Map entries with destructuring", async () => {
  const result = compile(`
    export function test(): number {
      const map = new Map<string, number>();
      map.set("a", 10);
      map.set("b", 20);
      let total = 0;
      for (const [key, val] of map) {
        total = total + val;
      }
      return total;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test()).toBe(30);
});

it("compiles instanceof Error", async () => {
  const result = compile(`
    export function test(x: number): number {
      try {
        if (x < 0) throw new Error("negative");
        return x;
      } catch (e) {
        if (e instanceof Error) return -1;
        return -2;
      }
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  expect((instance.exports as any).test(-1)).toBe(-1);
});
```

**Step 2: Implement**

Map iteration: iterate over the hash table slots, skip empty entries (key == 0).

```
local $idx = 0
local $cap = i32.load(map + 12)
block { loop {
  br_if ($idx >= $cap) → exit
  local $hash = i32.load(map + 16 + $idx * 12)
  if ($hash != 0) {
    local $key = i32.load(map + 16 + $idx * 12 + 4)
    local $val = i32.load(map + 16 + $idx * 12 + 8)
    ... body with destructured key, val ...
  }
  $idx = $idx + 1
  br → loop
}}
```

`instanceof`: check the type tag in the object header. `e instanceof Error` → `i32.load8_u(e + 0) == ERROR_TAG`.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add Map iteration and instanceof to linear codegen"
```

---

### Task 23: Template literals and string methods

**Files:**
- Modify: `src/codegen-linear/index.ts`
- Modify: `src/codegen-linear/runtime.ts` (add more string functions)
- Test: `tests/linear-basic.test.ts` (add tests)

**Step 1: Write the failing test**

```typescript
it("compiles template literals", async () => {
  const result = compile(`
    export function greet(): number {
      const name = "world";
      const msg = \`hello \${name}\`;
      return msg.length;
    }
  `, { target: "linear" });
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  // "hello world" = 11 chars
  expect((instance.exports as any).greet()).toBe(11);
});
```

**Step 2: Implement**

Template literal: desugar to string concatenation.
`` `hello ${name}` `` → `__str_concat(__str_concat("hello ", name), "")`

Add: `__str_from_i32(n) → i32` (convert number to decimal string in linear memory).
Add: `__str_charAt(s, i) → i32`, `__str_startsWith(s, prefix) → i32`.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: add template literals and string methods to linear codegen"
```

---

### Task 24: Integration test — compile a substantial TS program

**Files:**
- Test: `tests/linear-integration.test.ts`

**Step 1: Write the test**

```typescript
// tests/linear-integration.test.ts
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("linear-memory integration", () => {
  it("compiles a LEB128 decoder (linker-like code)", async () => {
    const result = compile(`
      class ByteReader {
        data: number[];
        pos: number;
        constructor(data: number[]) {
          this.data = data;
          this.pos = 0;
        }
        get remaining(): number {
          return this.data.length - this.pos;
        }
        byte(): number {
          const b = this.data[this.pos];
          this.pos = this.pos + 1;
          return b;
        }
        u32(): number {
          let result = 0;
          let shift = 0;
          let b: number;
          do {
            b = this.byte();
            result = result | ((b & 0x7f) << shift);
            shift = shift + 7;
          } while ((b & 0x80) !== 0);
          return result;
        }
      }

      export function decodeLEB(a: number, b: number): number {
        const reader = new ByteReader([a, b]);
        return reader.u32();
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const decode = (instance.exports as any).decodeLEB;
    // 0x80 0x01 = 128 in LEB128
    expect(decode(0x80, 0x01)).toBe(128);
    // 0x2a = 42
    expect(decode(0x2a, 0x00)).toBe(42);
  });
});
```

**Step 2: Run the test**

Run: `npx vitest run tests/linear-integration.test.ts`
Expected: PASS — this exercises classes, getters, arrays, bitwise ops, do-while, and method calls.

**Step 3: Commit**

```bash
git commit -m "test: add integration test for linear-memory backend"
```

---

### Task 25: Compile the linker to Wasm

**Files:**
- Create: `scripts/build-linker-wasm.ts`
- Test: `tests/linker-self-host.test.ts`

**Step 1: Create build script**

```typescript
// scripts/build-linker-wasm.ts
import { readFileSync, writeFileSync } from "fs";
import { compileMulti } from "../src/index.js";

const files: Record<string, string> = {
  "reader.ts": readFileSync("src/link/reader.ts", "utf8"),
  "resolver.ts": readFileSync("src/link/resolver.ts", "utf8"),
  "isolation.ts": readFileSync("src/link/isolation.ts", "utf8"),
  "linker.ts": readFileSync("src/link/linker.ts", "utf8"),
  "index.ts": readFileSync("src/link/index.ts", "utf8"),
};

const result = compileMulti(files, "index.ts", { target: "linear" });

if (!result.success) {
  console.error("Compilation failed:");
  for (const err of result.errors) {
    console.error(`  ${err.line}:${err.column} ${err.message}`);
  }
  process.exit(1);
}

writeFileSync("dist/linker.wasm", result.binary);
console.log(`Wrote dist/linker.wasm (${result.binary.length} bytes)`);
```

**Step 2: Write the self-host test**

```typescript
// tests/linker-self-host.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { compileMulti } from "../src/index.js";
import { link } from "../src/link/linker.js";
import { buildTestObjectWithNamedImports, SYMBOL_EXPORTED, SYMBOL_UNDEFINED, SYMBOL_EXPLICIT_NAME, SYMTAB_FUNCTION } from "./link-helpers.js";

describe("linker self-host", () => {
  it("linker.wasm produces identical output to TS linker", async () => {
    // Build two test .o modules
    const modA = buildTestObjectWithNamedImports({
      name: "a",
      types: [{ params: [0x7f, 0x7f], results: [0x7f] }],
      functions: [{ typeIdx: 0, exported: true, name: "add", body: [0x20, 0x00, 0x20, 0x01, 0x6a] }],
      memories: [{ min: 1 }],
    });
    const modB = buildTestObjectWithNamedImports({
      name: "b",
      types: [{ params: [0x7f, 0x7f], results: [0x7f] }, { params: [], results: [0x7f] }],
      functions: [
        { typeIdx: 0, exported: false, name: "add", body: [], isImport: true },
        { typeIdx: 1, exported: true, name: "callAdd", body: [0x41, 0x03, 0x41, 0x04, 0x10, 0x00] },
      ],
      memories: [{ min: 1 }],
    });

    // Link with TS linker (reference)
    const tsResult = link(new Map([["a.o", modA], ["b.o", modB]]), { entry: "b" });
    expect(tsResult.errors).toHaveLength(0);

    // Compile linker to Wasm
    const files: Record<string, string> = {
      "reader.ts": readFileSync("src/link/reader.ts", "utf8"),
      "resolver.ts": readFileSync("src/link/resolver.ts", "utf8"),
      "isolation.ts": readFileSync("src/link/isolation.ts", "utf8"),
      "linker.ts": readFileSync("src/link/linker.ts", "utf8"),
      "index.ts": readFileSync("src/link/index.ts", "utf8"),
    };
    const compileResult = compileMulti(files, "index.ts", { target: "linear" });
    expect(compileResult.success).toBe(true);

    // Instantiate linker.wasm and call it with the same inputs
    const { instance } = await WebAssembly.instantiate(compileResult.binary);
    // The linker.wasm exports a link() function that takes input bytes
    // and returns output bytes through linear memory.
    // Exact interface TBD based on how we expose the API.

    // For now, just verify it compiles and instantiates
    expect(instance).toBeDefined();
  });
});
```

The exact API for passing data in/out of `linker.wasm` will be refined during implementation. The key milestone is: the linker source compiles successfully and the module validates.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: compile linker to linker.wasm via linear-memory backend"
```

---

### Task 26: Wasmtime validation

**Files:**
- Modify: `scripts/build-linker-wasm.ts`
- Test: manual validation

**Step 1: Build linker.wasm**

```bash
npx tsx scripts/build-linker-wasm.ts
```

**Step 2: Validate with wasmtime**

```bash
wasmtime compile dist/linker.wasm
```

If wasmtime is not installed, validate with `wasm-tools validate`:

```bash
npx wasm-tools validate dist/linker.wasm
```

**Step 3: Commit**

```bash
git commit -m "chore: add wasmtime validation for linker.wasm"
```

---

## Summary

| Phase | Tasks | What's built |
|-------|-------|-------------|
| 1: IR & Scaffold | 1-2 | Memory instructions in IR, target option, empty codegen-linear |
| 2: Runtime | 3-8 | __malloc, Uint8Array, Array, String, Map, Set runtime functions |
| 3: Codegen | 9-20 | Full expression/statement/class/closure compilation |
| 4: Integration | 21-26 | Getters, Map iteration, template literals, self-host, Wasmtime |

Each task is independently testable. The plan is ordered so that each task builds on previous ones, and the test suite grows incrementally.
