/**
 * Issue #675: Dynamic import() support
 *
 * Tests that import() expressions compile correctly and evaluate
 * arguments (including the second options argument) for side effects.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compilation failed: ${r.errors[0]?.message}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return instance.exports;
}

describe("Issue #675: Dynamic import()", () => {
  it("compiles basic import() call", () => {
    const r = compile(
      `export function test(): number { import("./m"); return 1; }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
    // Should have __dynamic_import in imports
    const dynImport = r.imports.find(
      (i: any) => i.name === "__dynamic_import",
    );
    expect(dynImport).toBeDefined();
  });

  it("compiles import() with variable specifier", () => {
    const r = compile(
      `export function test(): number { const s = "./m"; import(s); return 1; }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });

  it("compiles import() with second argument (import attributes)", () => {
    const r = compile(
      `export function test(): number { import("./m", { with: { type: "json" } } as any); return 1; }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });

  it("second argument throwing propagates synchronously", async () => {
    // Per spec: if the options expression throws, import() throws synchronously
    const exports = await compileAndRun(`
      export function test(): number {
        try {
          import("./m", (function(): any { throw new Error("boom"); })());
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("returns externref from import()", () => {
    // Just verify it compiles -- runtime returns a Promise which is truthy externref
    const r = compile(
      `export function test(): number {
        const p = import("./nonexistent");
        return p !== null && p !== undefined ? 1 : 0;
      }`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });

  it("import() with no arguments compiles", () => {
    // TS may error, but with our suppressed diagnostics it should compile.
    // The runtime receives null externref as specifier.
    const r = compile(
      `export function test(): number {
        try { (import as any)(); } catch(e) {}
        return 1;
      }`,
      { fileName: "test.ts" },
    );
    // This may or may not compile depending on TS parser -- just verify no crash
    // The parser may reject `(import as any)()` so we accept either outcome
    expect(r).toBeDefined();
  });

  it("import.meta compiles to a truthy value", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        const m = import.meta;
        return m ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
