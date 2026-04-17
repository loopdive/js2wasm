/**
 * lodash-es Tier 1 E2E tests (#1107)
 *
 * Compiles real lodash-es functions to Wasm and asserts correct output.
 */
import { describe, it, expect } from "vitest";
import { compile, compileProject } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";
import { readFileSync } from "fs";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const LODASH_DIR = path.dirname(require.resolve("lodash-es/identity.js"));

async function compileSingleFile(file: string) {
  const src = readFileSync(path.join(LODASH_DIR, file), "utf-8");
  const result = compile(src, { fileName: file });
  expect(result.success, `compile ${file}: ${result.errors?.[0]?.message}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

async function compileMultiFile(file: string) {
  const result = compileProject(path.join(LODASH_DIR, file));
  expect(result.success, `compileProject ${file}: ${result.errors?.[0]?.message}`).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("lodash-es Tier 1 — self-contained functions", () => {
  it("identity(42) === 42", async () => {
    const exports = await compileSingleFile("identity.js");
    expect(exports.default(42)).toBe(42);
  });

  it("identity(0) === 0", async () => {
    const exports = await compileSingleFile("identity.js");
    expect(exports.default(0)).toBe(0);
  });

  it("identity(-1) === -1", async () => {
    const exports = await compileSingleFile("identity.js");
    expect(exports.default(-1)).toBe(-1);
  });

  it("noop() === undefined", async () => {
    const exports = await compileSingleFile("noop.js");
    expect(exports.default()).toBeUndefined();
  });

  it("stubTrue() returns truthy", async () => {
    const exports = await compileSingleFile("stubTrue.js");
    // Wasm returns i32 (1) for boolean true
    expect(!!exports.default()).toBe(true);
  });

  it("stubFalse() returns falsy", async () => {
    const exports = await compileSingleFile("stubFalse.js");
    // Wasm returns i32 (0) for boolean false
    expect(!!exports.default()).toBe(false);
  });
});

describe("lodash-es Tier 1 — multi-file functions", () => {
  it("compileProject resolves identity.js (allowJs auto-detection)", async () => {
    const result = compileProject(path.join(LODASH_DIR, "identity.js"));
    expect(result.success, `CE: ${result.errors?.[0]?.message}`).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports as any).default(42)).toBe(42);
  });

  it.skip("clamp(5, 0, 10) === 5 [known: toNumber dep chain]", async () => {
    const exports = await compileMultiFile("clamp.js");
    expect(exports.default(5, 0, 10)).toBe(5);
  });

  it.skip("add(3, 4) === 7 [known: HOF closure not exported]", async () => {
    const exports = await compileMultiFile("add.js");
    expect(exports.default(3, 4)).toBe(7);
  });
});
