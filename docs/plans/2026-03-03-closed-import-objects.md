# Closed Import Objects — Replace Proxy with Compiler Manifest

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the three runtime Proxy objects (`jsApi`, `domApi`, `buildImports` inner proxy) with a closed `buildImports()` that uses a compiler-generated import manifest, so only declared imports exist.

**Architecture:** The compiler already classifies every import in `generateEnvImportLine()` (compiler.ts:488-574). We extract that classification into a structured `ImportDescriptor[]` manifest on `CompileResult`, then build a plain frozen object from it in a new `buildImports()`. The three Proxies are deleted.

**Tech Stack:** TypeScript, Vitest, Wasm GC

---

### Task 1: Add `ImportDescriptor` type and `imports` field to `CompileResult`

**Files:**
- Modify: `src/index.ts:1-18`

**Step 1: Write the failing test**

Create `tests/closed-imports.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("ImportDescriptor manifest", () => {
  it("includes string literal imports", () => {
    const result = compile(`
      export function greet(): string { return "hello"; }
    `);
    expect(result.success).toBe(true);
    const strImport = result.imports.find(i => i.name === "__str_0");
    expect(strImport).toBeDefined();
    expect(strImport!.intent).toEqual({ type: "string_literal", value: "hello" });
  });

  it("includes Math imports", () => {
    const result = compile(`
      export function f(x: number): number { return Math.floor(x); }
    `);
    expect(result.success).toBe(true);
    const mathImport = result.imports.find(i => i.name === "Math_floor");
    expect(mathImport).toBeDefined();
    expect(mathImport!.intent).toEqual({ type: "math", method: "floor" });
  });

  it("includes console_log imports", () => {
    const result = compile(`
      export function f(): void { console.log(42); }
    `);
    expect(result.success).toBe(true);
    const logImport = result.imports.find(i => i.name === "console_log_number");
    expect(logImport).toBeDefined();
    expect(logImport!.intent).toEqual({ type: "console_log", variant: "number" });
  });

  it("includes extern class imports", () => {
    const result = compile(`
      declare class Element {
        textContent: string;
        appendChild(child: Element): void;
      }
      export function getText(el: Element): string {
        return el.textContent;
      }
    `);
    expect(result.success).toBe(true);
    const getImport = result.imports.find(i => i.name === "Element_get_textContent");
    expect(getImport).toBeDefined();
    expect(getImport!.intent).toEqual({
      type: "extern_class", className: "Element", action: "get", member: "textContent"
    });
  });

  it("includes string method imports", () => {
    const result = compile(`
      export function f(s: string): string { return s.trim(); }
    `);
    expect(result.success).toBe(true);
    const trimImport = result.imports.find(i => i.name === "string_trim");
    expect(trimImport).toBeDefined();
    expect(trimImport!.intent).toEqual({ type: "string_method", method: "trim" });
  });

  it("includes builtin imports", () => {
    const result = compile(`
      export function f(x: number): string { return x.toString(); }
    `);
    expect(result.success).toBe(true);
    const imp = result.imports.find(i => i.name === "number_toString");
    expect(imp).toBeDefined();
    expect(imp!.intent).toEqual({ type: "builtin", name: "number_toString" });
  });

  it("does not include wasm:js-string module imports in env manifest", () => {
    const result = compile(`
      export function f(): string { return "a" + "b"; }
    `);
    expect(result.success).toBe(true);
    // wasm:js-string imports (concat, length, etc.) should not appear in the env manifest
    const jsStringImports = result.imports.filter(i => i.module === "wasm:js-string");
    expect(jsStringImports.length).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/closed-imports.test.ts`
Expected: FAIL — `result.imports` is `undefined`

**Step 3: Add types and populate manifest**

In `src/index.ts`, add the `ImportDescriptor` type and `imports` field:

```typescript
export type ImportIntent =
  | { type: "string_literal"; value: string }
  | { type: "math"; method: string }
  | { type: "console_log"; variant: string }
  | { type: "extern_class"; className: string; action: "new" | "method" | "get" | "set"; member?: string }
  | { type: "string_method"; method: string }
  | { type: "builtin"; name: string }
  | { type: "callback_maker" }
  | { type: "await" }
  | { type: "typeof_check"; targetType: string }
  | { type: "box"; targetType: string }
  | { type: "unbox"; targetType: string }
  | { type: "extern_get" }
  | { type: "truthy_check" }
  | { type: "date_new" }
  | { type: "date_method"; method: string }
  | { type: "declared_global"; name: string };

export interface ImportDescriptor {
  module: "env" | "wasm:js-string" | "string_constants";
  name: string;
  kind: "func" | "global";
  intent: ImportIntent;
}

export interface CompileResult {
  binary: Uint8Array;
  wat: string;
  dts: string;
  importsHelper: string;
  success: boolean;
  errors: CompileError[];
  stringPool: string[];
  sourceMap?: string;
  imports: ImportDescriptor[];
}
```

**Step 4: Build the manifest in compiler.ts**

In `src/compiler.ts`, add a `buildImportManifest(mod: WasmModule): ImportDescriptor[]` function that classifies each import using the same logic as `generateEnvImportLine()`. Call it in `compileSource()` and `compileMultiSource()` and include it in the returned `CompileResult`.

```typescript
function classifyImport(name: string, mod: WasmModule): ImportIntent {
  // String literals
  const strValue = mod.stringLiteralValues.get(name);
  if (strValue !== undefined) return { type: "string_literal", value: strValue };

  // Console
  if (name === "console_log_number") return { type: "console_log", variant: "number" };
  if (name === "console_log_bool") return { type: "console_log", variant: "bool" };
  if (name === "console_log_string") return { type: "console_log", variant: "string" };
  if (name === "console_log_externref") return { type: "console_log", variant: "externref" };

  // Math
  if (name.startsWith("Math_")) return { type: "math", method: name.slice(5) };

  // String methods
  if (name.startsWith("string_")) return { type: "string_method", method: name.slice(7) };

  // Builtins
  if (name === "number_toString") return { type: "builtin", name };
  if (name === "number_toFixed") return { type: "builtin", name };

  // Date
  if (name === "Date_new") return { type: "date_new" };
  if (name.startsWith("Date_get")) return { type: "date_method", method: name.slice(5) };

  // Extern classes
  for (const ec of mod.externClasses) {
    const prefix = ec.importPrefix;
    if (name === `${prefix}_new`) return { type: "extern_class", className: ec.className, action: "new" };
    for (const [methodName] of ec.methods) {
      if (name === `${prefix}_${methodName}`) return { type: "extern_class", className: ec.className, action: "method", member: methodName };
    }
    for (const [propName] of ec.properties) {
      if (name === `${prefix}_get_${propName}`) return { type: "extern_class", className: ec.className, action: "get", member: propName };
      if (name === `${prefix}_set_${propName}`) return { type: "extern_class", className: ec.className, action: "set", member: propName };
    }
  }

  // Callback maker
  if (name === "__make_callback") return { type: "callback_maker" };

  // Async/await
  if (name === "__await") return { type: "await" };

  // Union type helpers
  if (name === "__typeof_number") return { type: "typeof_check", targetType: "number" };
  if (name === "__typeof_string") return { type: "typeof_check", targetType: "string" };
  if (name === "__typeof_boolean") return { type: "typeof_check", targetType: "boolean" };
  if (name === "__unbox_number") return { type: "unbox", targetType: "number" };
  if (name === "__unbox_boolean") return { type: "unbox", targetType: "boolean" };
  if (name === "__box_number") return { type: "box", targetType: "number" };
  if (name === "__box_boolean") return { type: "box", targetType: "boolean" };
  if (name === "__is_truthy") return { type: "truthy_check" };

  // Extern get
  if (name === "__extern_get") return { type: "extern_get" };

  // Declared globals (like `declare const document: Document`)
  if (name.startsWith("global_")) return { type: "declared_global", name: name.slice(7) };

  // Fallback
  return { type: "builtin", name };
}

function buildImportManifest(mod: WasmModule): ImportDescriptor[] {
  const manifest: ImportDescriptor[] = [];
  for (const imp of mod.imports) {
    if (imp.module !== "env") continue;
    manifest.push({
      module: "env",
      name: imp.name,
      kind: imp.desc.kind === "func" ? "func" : "global",
      intent: classifyImport(imp.name, mod),
    });
  }
  return manifest;
}
```

Add `imports: buildImportManifest(mod)` to both `compileSource()` and `compileMultiSource()` return objects.

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/closed-imports.test.ts`
Expected: All 7 tests PASS

**Step 6: Commit**

```bash
git add src/index.ts src/compiler.ts tests/closed-imports.test.ts
git commit -m "feat: add ImportDescriptor manifest to CompileResult (#67)"
```

---

### Task 2: New closed `buildImports()` using the manifest

**Files:**
- Modify: `src/runtime.ts:82-100`

**Step 1: Write the failing test**

Add to `tests/closed-imports.test.ts`:

```typescript
import { buildImports } from "../src/runtime.js";
import type { ImportDescriptor } from "../src/index.js";

describe("closed buildImports", () => {
  it("builds env from manifest with string literals", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "__str_0", kind: "func", intent: { type: "string_literal", value: "hello" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.__str_0()).toBe("hello");
  });

  it("builds env from manifest with Math", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Math_floor", kind: "func", intent: { type: "math", method: "floor" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.Math_floor(3.7)).toBe(3);
  });

  it("builds env from manifest with extern class", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Foo_get_bar", kind: "func", intent: { type: "extern_class", className: "Foo", action: "get", member: "bar" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.Foo_get_bar({ bar: 42 })).toBe(42);
  });

  it("does not include unlisted imports", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Math_floor", kind: "func", intent: { type: "math", method: "floor" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.Math_ceil).toBeUndefined();
    expect(imports.env.__extern_get).toBeUndefined();
    expect(imports.env.string_constructor).toBeUndefined();
  });

  it("extern class new uses deps", () => {
    class MyWidget { constructor(public x: number) {} }
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Widget_new", kind: "func", intent: { type: "extern_class", className: "Widget", action: "new" } },
    ];
    const imports = buildImports(manifest, { Widget: MyWidget });
    const w = imports.env.Widget_new(7);
    expect(w).toBeInstanceOf(MyWidget);
    expect(w.x).toBe(7);
  });

  it("string methods coerce receiver with String()", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "string_trim", kind: "func", intent: { type: "string_method", method: "trim" } },
    ];
    const imports = buildImports(manifest);
    expect(imports.env.string_trim("  hi  ")).toBe("hi");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/closed-imports.test.ts -t "closed buildImports"`
Expected: FAIL — `buildImports` still has old signature

**Step 3: Implement closed `resolveImport()` and new `buildImports()`**

Replace `buildImports()` in `src/runtime.ts` with:

```typescript
import type { ImportDescriptor, ImportIntent } from "./index.js";

function resolveImport(
  intent: ImportIntent,
  deps?: Record<string, any>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): Function {
  switch (intent.type) {
    case "string_literal":
      return () => intent.value;
    case "math":
      return (Math as any)[intent.method];
    case "console_log":
      return intent.variant === "bool"
        ? (v: number) => console.log(Boolean(v))
        : (v: any) => console.log(v);
    case "string_method": {
      const method = intent.method;
      return (s: any, ...a: any[]) => (String(s) as any)[method](...a);
    }
    case "extern_class": {
      if (intent.action === "new") {
        const Ctor = deps?.[intent.className];
        return (...args: any[]) => new Ctor(...args);
      }
      if (intent.action === "get") return (self: any) => self[intent.member!];
      if (intent.action === "set") return (self: any, v: any) => { self[intent.member!] = v; };
      // method
      const m = intent.member!;
      return (self: any, ...args: any[]) => self[m](...args);
    }
    case "builtin":
      if (intent.name === "number_toString") return (v: number) => String(v);
      if (intent.name === "number_toFixed") return (v: number, d: number) => v.toFixed(d);
      return () => {};
    case "callback_maker":
      return (id: number, cap: any) => (...args: any[]) => {
        const exports = callbackState?.getExports();
        return exports?.[`__cb_${id}`]?.(cap, ...args);
      };
    case "await":
      return (v: any) => v;
    case "typeof_check":
      return (v: any) => typeof v === intent.targetType ? 1 : 0;
    case "box":
      return intent.targetType === "boolean" ? (v: number) => Boolean(v) : (v: number) => v;
    case "unbox":
      return intent.targetType === "boolean" ? (v: any) => (v ? 1 : 0) : (v: any) => Number(v);
    case "truthy_check":
      return (v: any) => (v ? 1 : 0);
    case "extern_get":
      return (obj: any, idx: number) => obj[idx];
    case "date_new":
      return () => new Date();
    case "date_method": {
      const m = intent.method;
      return (d: any) => d[m]();
    }
    case "declared_global":
      return deps?.[intent.name] ?? (() => {});
    default:
      return () => {};
  }
}

export function buildImports(
  manifest: ImportDescriptor[],
  deps?: Record<string, any>,
): {
  env: Record<string, Function>;
  "wasm:js-string": typeof jsString;
  setExports?: (exports: Record<string, Function>) => void;
} {
  const env: Record<string, Function> = {};
  let wasmExports: Record<string, Function> | undefined;
  const callbackState = { getExports: () => wasmExports };
  let hasCallbacks = false;

  for (const imp of manifest) {
    if (imp.module !== "env") continue;
    env[imp.name] = resolveImport(imp.intent, deps, callbackState);
    if (imp.intent.type === "callback_maker") hasCallbacks = true;
  }

  const result: any = { env, "wasm:js-string": jsString };
  if (hasCallbacks) {
    result.setExports = (exports: Record<string, Function>) => { wasmExports = exports; };
  }
  return result;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/closed-imports.test.ts`
Expected: All tests PASS (both Task 1 and Task 2 tests)

**Step 5: Commit**

```bash
git add src/runtime.ts tests/closed-imports.test.ts
git commit -m "feat: closed buildImports() from manifest, no Proxy (#67)"
```

---

### Task 3: Delete Proxy exports, update `compileAndInstantiate()`

**Files:**
- Modify: `src/runtime.ts` — delete `jsApi`, `domApi` Proxies, update `compileAndInstantiate()`
- Modify: `src/index.ts:95-101` — remove `jsApi`, `domApi` from exports

**Step 1: Write the failing test**

Add to `tests/closed-imports.test.ts`:

```typescript
describe("compileAndInstantiate uses manifest", () => {
  it("compiles and runs with closed imports", async () => {
    const { compileAndInstantiate } = await import("../src/runtime.js");
    const exports = await compileAndInstantiate(`
      export function add(a: number, b: number): number { return a + b; }
    `);
    expect((exports as any).add(2, 3)).toBe(5);
  });

  it("compiles and runs with string literals", async () => {
    const { compileAndInstantiate } = await import("../src/runtime.js");
    const exports = await compileAndInstantiate(`
      export function greet(): string { return "hello world"; }
    `);
    expect((exports as any).greet()).toBe("hello world");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/closed-imports.test.ts -t "compileAndInstantiate uses manifest"`
Expected: May pass already if old code is still present — that's fine, these are regression guards.

**Step 3: Update `compileAndInstantiate()` and delete Proxies**

In `src/runtime.ts`:
- Delete the entire `jsApi` Proxy (lines 14-55)
- Delete the entire `domApi` Proxy (lines 58-80)
- Update `compileAndInstantiate()`:

```typescript
export async function compileAndInstantiate(
  source: string,
  deps?: Record<string, any>,
): Promise<WebAssembly.Exports> {
  const result = compileSource(source);
  if (!result.success) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  const manifest = buildImportManifest(result.mod);  // or use result.imports
  const imports = buildImports(result.imports, deps);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports;
}
```

Note: `compileAndInstantiate` calls `compileSource` which now returns `imports` on `CompileResult`. Use that directly.

In `src/index.ts`, update exports:

```typescript
export {
  jsString,
  buildImports,
  compileAndInstantiate,
  instantiateWasm,
} from "./runtime.js";

export type { ImportDescriptor, ImportIntent } from "./index.js";
```

Remove `jsApi` and `domApi` from the exports.

**Step 4: Run ALL existing tests**

Run: `npx vitest run`
Expected: Some tests will fail because they import `jsApi` and `domApi`

**Step 5: Fix test files that use old API**

Test files that import `jsApi`/`domApi`/old `buildImports`:
- `tests/module-globals.test.ts` — uses `buildImports(result.stringPool, jsApi)`
- `tests/playground-example.test.ts` — uses `buildImports(result.stringPool, jsApi, domApi)`
- `tests/string-enums.test.ts` — uses `buildImports(result.stringPool, jsApi)`
- `tests/try-catch.test.ts` — uses `buildImports(result.stringPool, jsApi)`
- `tests/union-narrowing.test.ts` — uses `buildImports(result.stringPool, jsApi)`
- `tests/equivalence.test.ts` — defines own `buildImports()` (keep as-is, no runtime import)

For each test file that uses the runtime's `buildImports`:
1. Change import from `import { buildImports, jsApi } from "../src/runtime.js"` to `import { buildImports } from "../src/runtime.js"`
2. Change `buildImports(result.stringPool, jsApi)` to `buildImports(result.imports)`
3. Change `buildImports(result.stringPool, jsApi, domApi)` to `buildImports(result.imports)`

The `compile()` call already returns `result.imports`, so test helpers just need the new signature.

**Step 6: Run ALL tests again**

Run: `npx vitest run`
Expected: All ~401 tests PASS

**Step 7: Commit**

```bash
git add src/runtime.ts src/index.ts tests/
git commit -m "refactor: remove jsApi/domApi Proxies, tests use manifest (#67)"
```

---

### Task 4: Update playground to use closed imports

**Files:**
- Modify: `playground/main.ts:2530-2578` — replace `domApi` fallback with `buildImports(result.imports)`

**Step 1: Read current playground buildEnv()**

The playground's `buildEnv()` at line ~2520 builds a custom env object with a Proxy that falls back to `domApi`. Replace this with `buildImports(result.imports, deps)` where `deps` provides the DOM classes and custom bindings.

**Step 2: Update playground/main.ts**

Replace the `buildEnv()` function to use `buildImports(result.imports, deps)` from the runtime. The playground already has the `CompileResult` available, so it can pass `result.imports` directly.

The playground's custom log redirection and preview panel bindings should be passed via `deps` or wrapped after building.

Key changes:
- Remove `import { domApi } from "../src/runtime.js"` — import `buildImports` instead
- Replace the inner Proxy with a call to `buildImports(result.imports, playgroundDeps)`
- Move custom playground bindings (console redirect, performance, DOM preview) into deps or overlay them on the env after building

**Step 3: Test manually in browser (if available) or verify no TypeScript errors**

Run: `npx tsc --noEmit playground/main.ts` (or equivalent)

**Step 4: Commit**

```bash
git add playground/main.ts
git commit -m "refactor: playground uses closed buildImports (#67)"
```

---

### Task 5: Security tests — verify closed surface

**Files:**
- Modify: `tests/closed-imports.test.ts`

**Step 1: Write security tests**

Add to `tests/closed-imports.test.ts`:

```typescript
describe("security: closed import surface", () => {
  it("hand-crafted import name not in manifest is absent", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Math_floor", kind: "func", intent: { type: "math", method: "floor" } },
    ];
    const imports = buildImports(manifest);
    // Attacker tries to request __proto__, constructor, etc.
    expect(imports.env["__proto__"]).toBeUndefined();
    expect(imports.env["constructor"]).toBeUndefined();
    expect(imports.env["Element_get___proto__"]).toBeUndefined();
    expect(imports.env["Element_get_constructor"]).toBeUndefined();
    expect(imports.env["__extern_get"]).toBeUndefined();
    expect(imports.env["string_constructor"]).toBeUndefined();
  });

  it("string methods coerce to String preventing prototype attacks", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "string_trim", kind: "func", intent: { type: "string_method", method: "trim" } },
    ];
    const imports = buildImports(manifest);
    // Even if a non-string is passed, String() coercion prevents prototype chain walking
    expect(imports.env.string_trim("  hi  ")).toBe("hi");
  });

  it("extern class get only accesses the declared member", () => {
    const manifest: ImportDescriptor[] = [
      { module: "env", name: "Element_get_textContent", kind: "func",
        intent: { type: "extern_class", className: "Element", action: "get", member: "textContent" } },
    ];
    const imports = buildImports(manifest);
    // The generated function only accesses .textContent — not a dynamic property name
    const fake = { textContent: "hello", __proto__: "evil" };
    expect(imports.env.Element_get_textContent(fake)).toBe("hello");
  });

  it("full compile→instantiate round-trip with closed imports", async () => {
    const result = compile(`
      export function add(a: number, b: number): number {
        return Math.floor(a) + Math.floor(b);
      }
    `);
    expect(result.success).toBe(true);
    expect(result.imports.length).toBeGreaterThan(0);

    const imports = buildImports(result.imports);
    const { instance } = await WebAssembly.instantiate(
      result.binary as BufferSource,
      imports as WebAssembly.Imports,
    );
    expect((instance.exports as any).add(1.5, 2.7)).toBe(3);
  });
});
```

**Step 2: Run tests**

Run: `npx vitest run tests/closed-imports.test.ts`
Expected: All PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All ~401 tests PASS

**Step 4: Commit**

```bash
git add tests/closed-imports.test.ts
git commit -m "test: security tests for closed import surface (#67)"
```

---

### Summary of changes

| File | Change |
|------|--------|
| `src/index.ts` | Add `ImportDescriptor`, `ImportIntent` types. Add `imports` to `CompileResult`. Remove `jsApi`/`domApi` re-exports. |
| `src/compiler.ts` | Add `classifyImport()` and `buildImportManifest()`. Call in `compileSource()`/`compileMultiSource()`. |
| `src/runtime.ts` | Delete `jsApi` Proxy, `domApi` Proxy. New `resolveImport()` + closed `buildImports(manifest, deps)`. Update `compileAndInstantiate()`. |
| `playground/main.ts` | Replace `domApi` Proxy fallback with `buildImports(result.imports, deps)`. |
| `tests/closed-imports.test.ts` | New test file: manifest generation tests + closed builder tests + security tests. |
| `tests/*.test.ts` (5 files) | Update `buildImports()` calls from old signature to new manifest-based signature. |
