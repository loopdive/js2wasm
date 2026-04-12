/**
 * #1074 — Surface ESM `export default` as Wasm function export
 *
 * Tests that `export default <fn>` produces callable Wasm exports.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors[0]?.message}`);
  }
  return result;
}

async function instantiate(result: ReturnType<typeof compile>) {
  if (!result.success) throw new Error("Compile failed");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance;
}

describe("#1074 — export default", () => {
  it("export default <identifier> — named function exported under both name and 'default'", async () => {
    const source = `
      function identity(value: number): number { return value; }
      export default identity;
    `;
    const result = compileAndRun(source);
    const instance = await instantiate(result);
    const exports = instance.exports as Record<string, Function>;

    // Should have both "identity" and "default" exports
    expect(typeof exports.identity).toBe("function");
    expect(typeof exports.default).toBe("function");

    // Both should return the same result
    expect(exports.identity(42)).toBe(42);
    expect(exports.default(42)).toBe(42);
  });

  it("export default function foo() {} — inline named default export", async () => {
    const source = `
      export default function double(x: number): number { return x * 2; }
    `;
    const result = compileAndRun(source);
    const instance = await instantiate(result);
    const exports = instance.exports as Record<string, Function>;

    // Should have both "double" and "default" exports
    expect(typeof exports.double).toBe("function");
    expect(typeof exports.default).toBe("function");
    expect(exports.double(5)).toBe(10);
    expect(exports.default(5)).toBe(10);
  });

  it("export default function() {} — anonymous default export", async () => {
    const source = `
      export default function(x: number): number { return x + 1; }
    `;
    const result = compileAndRun(source);
    const instance = await instantiate(result);
    const exports = instance.exports as Record<string, Function>;

    // Anonymous default export is only available as "default"
    expect(typeof exports.default).toBe("function");
    expect(exports.default(10)).toBe(11);
  });

  it("existing named exports still work alongside default", async () => {
    const source = `
      export function add(a: number, b: number): number { return a + b; }
      function sub(a: number, b: number): number { return a - b; }
      export default sub;
    `;
    const result = compileAndRun(source);
    const instance = await instantiate(result);
    const exports = instance.exports as Record<string, Function>;

    expect(typeof exports.add).toBe("function");
    expect(typeof exports.sub).toBe("function");
    expect(typeof exports.default).toBe("function");
    expect(exports.add(3, 2)).toBe(5);
    expect(exports.sub(3, 2)).toBe(1);
    expect(exports.default(3, 2)).toBe(1);
  });

  it("lodash-es identity pattern compiles with exports", () => {
    // Simplified lodash-es/identity.js pattern (as JS with type annotations for our compiler)
    const source = `
      function identity(value: number): number { return value; }
      export default identity;
    `;
    const result = compileAndRun(source);
    // Verify the binary has function exports
    const mod = new WebAssembly.Module(result.binary);
    const wasmExports = WebAssembly.Module.exports(mod);
    const funcExports = wasmExports.filter((e) => e.kind === "function");
    expect(funcExports.length).toBeGreaterThan(0);
    expect(funcExports.some((e) => e.name === "default")).toBe(true);
    expect(funcExports.some((e) => e.name === "identity")).toBe(true);
  });
});
