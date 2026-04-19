// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1075 — CommonJS module.exports / exports.foo support
 *
 * Verifies that CJS export patterns are recognized and surfaced as Wasm exports:
 * - module.exports = <identifier>
 * - module.exports = function() {}
 * - module.exports.foo = function() {}
 * - exports.foo = function() {}
 * - exports.foo = <identifier>
 * - Mixed CJS patterns
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string): Promise<Record<string, any>> {
  const result = compile(source, { allowJs: true, fileName: "test.js" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors.map((e) => e.message).join(", ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, any>;
}

function getExportNames(source: string): string[] {
  const result = compile(source, { allowJs: true, fileName: "test.js" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors.map((e) => e.message).join(", ")}`);
  }
  const mod = new WebAssembly.Module(result.binary);
  return WebAssembly.Module.exports(mod)
    .filter((e) => e.kind === "function")
    .map((e) => e.name);
}

describe("CJS module.exports = <identifier>", () => {
  it("exports a top-level function as default", async () => {
    const exports = await compileAndRun(`
      function identity(x) { return x; }
      module.exports = identity;
    `);
    expect(exports.identity(42)).toBe(42);
    expect(exports.default(42)).toBe(42);
  });

  it("exports function names correctly", () => {
    const names = getExportNames(`
      function identity(x) { return x; }
      module.exports = identity;
    `);
    expect(names).toContain("identity");
    expect(names).toContain("default");
  });
});

describe("CJS module.exports = function() {}", () => {
  it("exports a named function expression as default", async () => {
    const exports = await compileAndRun(`
      module.exports = function double(x) { return x * 2; };
    `);
    expect(exports.double(5)).toBe(10);
    expect(exports.default(5)).toBe(10);
  });
});

describe("CJS module.exports.foo = function() {}", () => {
  it("exports a named function expression", async () => {
    const exports = await compileAndRun(`
      module.exports.square = function square(x) { return x * x; };
    `);
    expect(exports.square(5)).toBe(25);
    expect(exports.square(0)).toBe(0);
    expect(exports.square(-3)).toBe(9);
  });
});

describe("CJS exports.foo = function() {}", () => {
  it("exports a named function expression", async () => {
    const exports = await compileAndRun(`
      exports.add = function add(a, b) { return a + b; };
    `);
    expect(exports.add(3, 4)).toBe(7);
  });
});

describe("CJS exports.foo = <identifier>", () => {
  it("exports an existing function by reference", async () => {
    const exports = await compileAndRun(`
      function multiply(a, b) { return a * b; }
      exports.multiply = multiply;
    `);
    expect(exports.multiply(3, 4)).toBe(12);
  });
});

describe("CJS mixed patterns", () => {
  it("supports module.exports default + named exports together", async () => {
    const exports = await compileAndRun(`
      function identity(x) { return x; }
      module.exports = identity;
      module.exports.double = function double(x) { return x * 2; };
      exports.triple = function triple(x) { return x * 3; };
    `);
    expect(exports.identity(42)).toBe(42);
    expect(exports.default(42)).toBe(42);
    expect(exports.double(5)).toBe(10);
    expect(exports.triple(5)).toBe(15);
  });

  it("supports multiple named exports without default", async () => {
    const names = getExportNames(`
      exports.add = function add(a, b) { return a + b; };
      exports.sub = function sub(a, b) { return a - b; };
      module.exports.mul = function mul(a, b) { return a * b; };
    `);
    expect(names).toContain("add");
    expect(names).toContain("sub");
    expect(names).toContain("mul");
  });
});
