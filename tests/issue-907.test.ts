import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

/**
 * Issue #907 — Replace `__init_done` runtime guards with start/init entry semantics.
 *
 * For modules without a user-declared `main()` that have top-level executable
 * statements, the compiler now wires `__module_init` into the Wasm `start`
 * section so initialization runs automatically during `WebAssembly.instantiate()`.
 *
 * This eliminates two legacy mechanisms:
 *   - the `__init_done` runtime guard global plus per-export guard preambles, and
 *   - the `_start` export wrapper used for module-init-only programs.
 *
 * WASI mode is unaffected: `addWasiStartExport` continues to emit a `_start`
 * export that wraps `__module_init`, and the WASI host calls it explicitly.
 */

async function compileAndInstantiate(src: string) {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`CE: ${r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return { result: r, instance };
}

describe("#907 — Wasm start section replaces __init_done guards", () => {
  it("module-init-only program (the issue example) emits start section, not __init_done", () => {
    const src = `
function squared(n: number): number { return n * n; }

let result = 0;

for (let i = 0; i < 10000; i++) {
  result += squared(10);
}

console.log(result);
`;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(r.wat).toContain("(start ");
    expect(r.wat).not.toContain("__init_done");
    // No `_start` export wrapper — start section runs init on instantiation.
    expect(r.wat).not.toMatch(/\(export "_start"/);
  });

  it("module-init-only program runs top-level code on instantiation", async () => {
    let logged: number | undefined;
    const src = `
function squared(n: number): number { return n * n; }

let result = 0;

for (let i = 0; i < 100; i++) {
  result += squared(10);
}

console.log(result);
`;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    // Override console_log_number to capture output
    (imports.env as Record<string, unknown>).console_log_number = (v: number) => {
      logged = v;
    };
    await WebAssembly.instantiate(r.binary, imports);
    // squared(10) = 100, summed 100 times = 10000
    expect(logged).toBe(10000);
  });

  it("module with exports + top-level: init runs before exported function is called", async () => {
    const src = `
let initialized = 0;
initialized = 42;
export function test(): number { return initialized; }
`;
    const { instance } = await compileAndInstantiate(src);
    const test = (instance.exports as { test: () => number }).test;
    expect(test()).toBe(42);
  });

  it("exports + top-level emits start section but no __init_done guard", () => {
    const src = `
let x = 0;
x = 7;
export function getX(): number { return x; }
`;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(r.wat).toContain("(start ");
    expect(r.wat).not.toContain("__init_done");
  });

  it("module with main() and top-level statements: init prepended to main, no start section", () => {
    const src = `
let counter = 0;
counter = 5;
export function main(): number { return counter; }
`;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    // main() carries the init body; no start section needed
    expect(r.wat).not.toContain("(start ");
    expect(r.wat).not.toContain("__init_done");
  });

  it("pure exports without top-level statements: no start section, no __init_done", () => {
    const src = `export function add(a: number, b: number): number { return a + b; }`;
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(r.wat).not.toContain("(start ");
    expect(r.wat).not.toContain("__init_done");
  });

  it("WASI target keeps _start export and does NOT use start section", () => {
    // For WASI mode, the host calls _start() explicitly; the start section
    // would cause init to run twice (once on instantiate + once on _start()).
    const src = `console.log("hello");`;
    const r = compile(src, { fileName: "test.ts", target: "wasi" });
    expect(r.success).toBe(true);
    expect(r.wat).toMatch(/\(export "_start"/);
    expect(r.wat).not.toContain("(start ");
    expect(r.wat).not.toContain("__init_done");
  });

  it("init runs exactly once, even with multiple exported function calls", async () => {
    // Previously, the __init_done guard ensured init ran exactly once.
    // The Wasm start section provides the same guarantee structurally:
    // the engine runs `start` exactly once per instance during instantiation.
    const src = `
let counter = 0;
counter = counter + 1;
export function getCounter(): number { return counter; }
export function bump(): number { counter = counter + 1; return counter; }
`;
    const { instance } = await compileAndInstantiate(src);
    const e = instance.exports as { getCounter: () => number; bump: () => number };
    expect(e.getCounter()).toBe(1); // init ran once
    expect(e.bump()).toBe(2);
    expect(e.bump()).toBe(3);
    // getCounter doesn't reinitialize
    expect(e.getCounter()).toBe(3);
  });
});
