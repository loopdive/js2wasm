import { describe, it, expect } from "vitest";
import { compileProject, ModuleResolver, resolveAllImports } from "../../src/index.js";
import * as path from "node:path";
import { existsSync } from "node:fs";

/**
 * Issue #1031 — lodash Tier 1 stress test.
 *
 * Goal: compile a real lodash module through compileProject end-to-end,
 * load the resulting Wasm, invoke the exported function, and assert correctness.
 *
 * Current state (2026-04-11): the stress test documents a precondition gap.
 * compileProject does not yet compile npm-installed lodash sources to Wasm
 * in a way that produces a callable exported function. See
 * plan/issues/1031.md "## Stress Test Results" for the full write-up.
 *
 * These tests encode the CURRENT observed behavior so future work (follow-up
 * issues filed from #1031) can flip the assertions when the gaps are closed.
 */

const lodashEsInstalled = existsSync("node_modules/lodash-es/identity.js");
const lodashCjsInstalled = existsSync("node_modules/lodash/identity.js");
const runIfInstalled = lodashEsInstalled && lodashCjsInstalled ? it : it.skip;

describe("#1031 lodash Tier 1 stress test", () => {
  runIfInstalled("compileProject on CommonJS lodash/identity.js: no ESM exports emitted (documented gap)", () => {
    const result = compileProject("node_modules/lodash/identity.js", { allowJs: true });
    expect(result.success).toBe(true);

    // The CJS `module.exports = identity` pattern is NOT understood as an ESM export,
    // and there are no `export` keywords in the source, so the Wasm has no function exports.
    const mod = new WebAssembly.Module(result.binary);
    const exports = WebAssembly.Module.exports(mod);
    const funcExports = exports.filter((e) => e.kind === "function");
    expect(funcExports).toEqual([]);
  });

  runIfInstalled(
    "compileProject on ESM lodash-es/identity.js: `export default` not emitted as Wasm export (documented gap)",
    () => {
      const result = compileProject("node_modules/lodash-es/identity.js", { allowJs: true });
      expect(result.success).toBe(true);

      // lodash-es uses `function identity(v) { return v; }` + `export default identity`.
      // The default export is not currently surfaced as a named Wasm function export
      // by compileMultiSource, so there is nothing callable from the host.
      const mod = new WebAssembly.Module(result.binary);
      const exports = WebAssembly.Module.exports(mod);
      const funcExports = exports.filter((e) => e.kind === "function");
      expect(funcExports).toEqual([]);
    },
  );

  runIfInstalled(
    "compileProject on ESM lodash-es/clamp.js: Wasm validation fails on generated toNumber (documented gap)",
    () => {
      const result = compileProject("node_modules/lodash-es/clamp.js", { allowJs: true });
      expect(result.success).toBe(true);

      // Codegen emits an invalid Wasm module for lodash-es/clamp.js: the `toNumber`
      // helper produces an if-branch with a type mismatch (i32 vs externref). This
      // is a real codegen bug surfaced by the stress test, not an ergonomic gap.
      expect(() => new WebAssembly.Module(result.binary)).toThrow(/type|externref|i32/);
    },
  );

  runIfInstalled(
    "compileProject on ESM lodash-es/add.js: Wasm validation fails on undeclared function reference (documented gap)",
    () => {
      const result = compileProject("node_modules/lodash-es/add.js", { allowJs: true });
      expect(result.success).toBe(true);

      // add.js uses `createMathOperation(fn, 0)` with a closure; codegen emits a
      // reference to an undeclared function slot for the closure parameter.
      expect(() => new WebAssembly.Module(result.binary)).toThrow(/undeclared reference to function/);
    },
  );

  runIfInstalled(
    "ModuleResolver on `lodash-es/identity.js` resolves to @types/.d.ts, not the real .js body (root cause)",
    () => {
      const rootDir = path.resolve(".");
      const resolver = new ModuleResolver(rootDir, { allowJs: true });
      const resolved = resolver.resolve("lodash-es/identity.js", path.resolve("dummy.ts"));

      // When `@types/lodash-es` is installed, TypeScript's standard module resolver
      // prefers the `.d.ts` declaration over the real `.js` body. resolveAllImports
      // then walks only the type declarations and never loads the implementation.
      expect(resolved).toMatch(/@types[\\/]lodash-es[\\/]identity\.d\.ts$/);
    },
  );

  runIfInstalled("resolveAllImports walks @types/.d.ts declarations only (root cause)", () => {
    const rootDir = path.resolve(".");
    const resolver = new ModuleResolver(rootDir, { allowJs: true });

    // Write a minimal shim that imports lodash-es/identity and calls it.
    // The shim lives under .tmp/ (gitignored scratch) and is created on the fly.
    const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(".tmp", { recursive: true });
    const shim = path.resolve(".tmp/shim-identity.ts");
    writeFileSync(
      shim,
      `import identity from "lodash-es/identity.js";\nexport function run(x: number): number { return identity(x); }\n`,
    );

    const files = resolveAllImports(shim, resolver);
    const keys = Array.from(files.keys());
    const anyRealJs = keys.some((k) => /node_modules[\\/]lodash-es[\\/].*\.js$/.test(k) && !k.includes("@types"));
    const anyTypeDecl = keys.some((k) => /@types[\\/]lodash-es[\\/].*\.d\.ts$/.test(k));

    // Current behavior: @types decls are walked, real .js bodies are not.
    expect(anyTypeDecl).toBe(true);
    expect(anyRealJs).toBe(false);
  });
});
