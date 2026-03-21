import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";

/**
 * Issue #723 — TDZ (Temporal Dead Zone) runtime enforcement for let/const.
 * When a let/const variable is accessed before its declaration runs,
 * a ReferenceError should be thrown at runtime.
 */

function buildImports(wasmModule: WebAssembly.Module): Record<string, Record<string, any>> {
  const importObj: Record<string, Record<string, any>> = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (!importObj[imp.module]) importObj[imp.module] = {};
    if (imp.kind === "function") {
      importObj[imp.module]![imp.name] = (...args: any[]) => args[0];
    } else if (imp.kind === "global") {
      importObj[imp.module]![imp.name] = imp.name;
    } else if (imp.kind === "tag") {
      importObj[imp.module]![imp.name] = new WebAssembly.Tag({ parameters: ["externref"] });
    }
  }
  return importObj;
}

function compileAndRun(code: string): number {
  const result = compile(code);
  expect(result.success).toBe(true);
  const wasmModule = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(wasmModule, buildImports(wasmModule));
  const exports = instance.exports as any;
  return exports.getResult();
}

describe("TDZ runtime enforcement (#723)", () => {
  test("module-level: reading let before declaration throws ReferenceError", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      let x: number = 42;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    expect(val).toBe(1);
  });

  test("module-level: let without initializer still ends TDZ", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      let x: number;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    expect(val).toBe(1);
  });

  test("module-level: const before declaration throws ReferenceError", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      const x: number = 99;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    expect(val).toBe(1);
  });

  test("module-level: var has NO TDZ (hoisted)", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      function readX(): number { return x; }
      let caught = false;
      try { readX(); } catch (e) { caught = true; }
      var x: number = 42;
      export function getResult(): number { return caught ? 1 : 0; }
    `);
    // var is hoisted, so readX() should NOT throw
    expect(val).toBe(0);
  });

  test("module-level: after declaration, variable is accessible", { timeout: 15000 }, () => {
    const val = compileAndRun(`
      let x: number = 42;
      function readX(): number { return x; }
      export function getResult(): number { return readX(); }
    `);
    expect(val).toBe(42);
  });

  test("TDZ flag globals are present in WAT output", { timeout: 15000 }, () => {
    const result = compile(`
      export function f(): number { return x; }
      let x: number = 1;
    `);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__tdz_x");
  });

  test("no TDZ flag for var declarations", { timeout: 15000 }, () => {
    const result = compile(`
      export function f(): number { return x; }
      var x: number = 1;
    `);
    expect(result.success).toBe(true);
    expect(result.wat).not.toContain("__tdz_x");
  });
});
