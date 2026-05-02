// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1277 — CommonJS `module.exports` / `exports.foo` → Wasm export mapping.
//
// The CJS export-discovery walker in `src/codegen/declarations.ts` already
// handled the simple identifier and function-expression shapes via the existing
// `module.exports` / `exports.foo` patterns. The fix here adds two missing
// shapes that real npm packages (lodash, lodash-es shim files) and ESM
// re-export style modules use:
//
//   - `module.exports = { a, b: c }` — multi-named export via object literal.
//     Each shorthand or named-with-identifier property becomes a Wasm export.
//   - `export { foo, bar as baz };` — ESM named-export declaration without a
//     `from` specifier. The export-discovery walker now resolves the local
//     binding and emits the function under the exported alias.
//
// Re-exports (`export { x } from "spec"`) are intentionally NOT covered here
// — they require import resolution + re-export wiring that's separate from
// the export-discovery gap.

import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runExport(source: string, exportName: string, args: unknown[]): Promise<unknown> {
  const r = compile(source, {
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    allowJs: true,
  });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as Record<string, Function>);
  const fn = (instance.exports as Record<string, unknown>)[exportName];
  if (typeof fn !== "function") {
    throw new Error(`export '${exportName}' missing. Available: ${Object.keys(instance.exports).join(", ")}`);
  }
  return (fn as (...a: unknown[]) => unknown)(...args);
}

function getExports(source: string): string[] {
  const r = compile(source, {
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    allowJs: true,
  });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  // Synchronous parse of WebAssembly module bytes via WebAssembly.Module
  const m = new WebAssembly.Module(r.binary);
  return WebAssembly.Module.exports(m).map((e) => e.name);
}

describe("Issue #1277 — CJS module.exports → Wasm export mapping", () => {
  // ── Pre-existing behaviour (regression guards for #1075) ─────────
  it("module.exports = ident — exports both ident and default", async () => {
    const src = `function identity(value) { return value; }
module.exports = identity;`;
    const exps = getExports(src);
    expect(exps).toContain("identity");
    expect(exps).toContain("default");
    expect(await runExport(src, "default", [42])).toBe(42);
    expect(await runExport(src, "identity", [42])).toBe(42);
  });

  it("module.exports.foo = ident — exports as foo", async () => {
    const src = `function double(x) { return x * 2; }
module.exports.double = double;`;
    expect(getExports(src)).toContain("double");
    expect(await runExport(src, "double", [21])).toBe(42);
  });

  it("exports.foo = ident — exports as foo", async () => {
    const src = `function add(a, b) { return a + b; }
exports.add = add;`;
    expect(getExports(src)).toContain("add");
    expect(await runExport(src, "add", [2, 3])).toBe(5);
  });

  it("exports.foo = function expression — exports as foo", async () => {
    const src = `exports.add = function(a, b) { return a + b; };`;
    expect(getExports(src)).toContain("add");
    expect(await runExport(src, "add", [2, 3])).toBe(5);
  });

  // ── New: object-literal RHS (#1277) ───────────────────────────────
  it("module.exports = { a, b } — exports both a and b", async () => {
    const src = `function inc(x) { return x + 1; }
function dec(x) { return x - 1; }
module.exports = { inc, dec };`;
    const exps = getExports(src);
    expect(exps).toContain("inc");
    expect(exps).toContain("dec");
    expect(await runExport(src, "inc", [10])).toBe(11);
    expect(await runExport(src, "dec", [10])).toBe(9);
  });

  it("module.exports = { alias: ident } — exports under aliased name", async () => {
    const src = `function _double(x) { return x * 2; }
module.exports = { times2: _double };`;
    expect(getExports(src)).toContain("times2");
    expect(await runExport(src, "times2", [21])).toBe(42);
  });

  // ── New: ESM `export { name }` declaration (#1277) ────────────────
  it("export { ident } — exports as ident (JS mode)", async () => {
    const src = `function identity(v) { return v; }
export { identity };`;
    expect(getExports(src)).toContain("identity");
    expect(await runExport(src, "identity", [42])).toBe(42);
  });

  it("export { ident as alias } — exports under alias", async () => {
    const src = `function identity(v) { return v; }
export { identity as id };`;
    expect(getExports(src)).toContain("id");
    expect(await runExport(src, "id", [99])).toBe(99);
  });

  it("export { a, b } — multi-spec named export", async () => {
    const src = `function inc(x) { return x + 1; }
function dec(x) { return x - 1; }
export { inc, dec };`;
    const exps = getExports(src);
    expect(exps).toContain("inc");
    expect(exps).toContain("dec");
    expect(await runExport(src, "inc", [5])).toBe(6);
    expect(await runExport(src, "dec", [5])).toBe(4);
  });

  // ── compileMulti routes through generateMultiModule ───────────────
  it("compileMulti routes module.exports through the same path", async () => {
    const r = compileMulti(
      {
        "./identity.js": `function identity(value) { return value; }
module.exports = identity;`,
      },
      "./identity.js",
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const m = new WebAssembly.Module(r.binary);
    const exps = WebAssembly.Module.exports(m).map((e) => e.name);
    expect(exps).toContain("identity");
    expect(exps).toContain("default");
  });

  it("compileMulti supports module.exports = { a, b } across files", async () => {
    const r = compileMulti(
      {
        "./mod.js": `function inc(x) { return x + 1; }
function dec(x) { return x - 1; }
module.exports = { inc, dec };`,
      },
      "./mod.js",
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const m = new WebAssembly.Module(r.binary);
    const exps = WebAssembly.Module.exports(m).map((e) => e.name);
    expect(exps).toContain("inc");
    expect(exps).toContain("dec");
  });

  // ── Regression: ESM still works ──────────────────────────────────
  it("regression guard: export function foo still emits foo export", async () => {
    const src = `export function foo(x) { return x + 1; }`;
    expect(getExports(src)).toContain("foo");
    expect(await runExport(src, "foo", [10])).toBe(11);
  });

  it("regression guard: export default ident still emits both names", async () => {
    const src = `function identity(v) { return v; }
export default identity;`;
    const exps = getExports(src);
    expect(exps).toContain("identity");
    expect(exps).toContain("default");
  });
});
