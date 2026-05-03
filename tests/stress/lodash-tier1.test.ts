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
 * Status (refresh 2026-05-02 per #1278): the gaps documented in the original
 * 2026-04-11 write-up have been closed:
 *
 *   - CJS `module.exports = identity` is now compiled to ESM `default`/`identity`
 *     exports (was: no exports).
 *   - ModuleResolver now prefers real `.js` bodies over `@types/.d.ts`
 *     declarations (was: walked types only).
 *   - clamp.js and add.js now validate as Wasm modules (were: Wasm validation
 *     errors). They still fail at instantiation due to missing imports —
 *     tracked separately under #1276 (HOF returning closure / createMathOperation
 *     pattern in add.js) and a clamp follow-up.
 *
 * Tests in this file now assert the *current correct* behavior. The remaining
 * gaps (clamp/add instantiation) are gated `.skip` with issue refs.
 */

const lodashEsInstalled = existsSync("node_modules/lodash-es/identity.js");
const lodashCjsInstalled = existsSync("node_modules/lodash/identity.js");
const runIfInstalled = lodashEsInstalled && lodashCjsInstalled ? it : it.skip;

describe("#1031 lodash Tier 1 stress test", () => {
  runIfInstalled(
    "compileProject on CommonJS lodash/identity.js: emits identity + default exports (#1277)",
    async () => {
      const result = compileProject("node_modules/lodash/identity.js", { allowJs: true });
      expect(result.success).toBe(true);

      // After the CJS-to-ESM bridge work, `module.exports = identity` surfaces both
      // `default` and `identity` as Wasm function exports. (Previously: empty.)
      const mod = new WebAssembly.Module(result.binary);
      const exports = WebAssembly.Module.exports(mod);
      const funcNames = exports.filter((e) => e.kind === "function").map((e) => e.name);
      expect(funcNames).toContain("identity");
      expect(funcNames).toContain("default");

      const imports = (await import("../../src/runtime.ts")).buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      const e = instance.exports as Record<string, Function>;
      expect(e.identity(42)).toBe(42);
      expect(e.default(42)).toBe(42);
    },
  );

  runIfInstalled("compileProject on ESM lodash-es/identity.js: exports default + identity (#1074)", async () => {
    const result = compileProject("node_modules/lodash-es/identity.js", { allowJs: true });
    expect(result.success).toBe(true);

    // After #1074, `export default identity` surfaces both "default" and "identity"
    // as Wasm function exports. identity(x) returns x unchanged.
    const imports = (await import("../../src/runtime.ts")).buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, Function>;
    expect(typeof exports.default).toBe("function");
    expect(typeof exports.identity).toBe("function");
    expect(exports.default(42)).toBe(42);
    expect(exports.identity(42)).toBe(42);
    expect(exports.identity(0)).toBe(0);
  });

  runIfInstalled(
    "compileProject on ESM lodash-es/clamp.js: validates + all imports resolve; start function throws (#1291)",
    async () => {
      const result = compileProject("node_modules/lodash-es/clamp.js", { allowJs: true });
      expect(result.success).toBe(true);

      // Wasm validation passes. Module shape exposes `clamp` and `default`
      // as actual function exports (not globals).
      const mod = new WebAssembly.Module(result.binary);
      const funcNames = WebAssembly.Module.exports(mod)
        .filter((e) => e.kind === "function")
        .map((e) => e.name);
      expect(funcNames).toContain("clamp");
      expect(funcNames).toContain("default");

      // #1291 finding: contrary to the original "missing import" theory, every
      // Wasm import is satisfied by buildImports — the gap is in the start
      // function (top-level module init), which throws a WebAssembly.Exception
      // while running lodash's transitive feature-detection deps (`_root.js`,
      // `_Symbol.js`, etc.). Verify the import-resolution claim explicitly so
      // a regression there can't slip in disguised as the start-function throw.
      const imports = (await import("../../src/runtime.ts")).buildImports(result.imports, undefined, result.stringPool);
      const wasmImports = WebAssembly.Module.imports(mod);
      const missing = wasmImports.filter((w) => {
        const m = (imports as Record<string, Record<string, unknown>>)[w.module];
        return m === undefined || !(w.name in m);
      });
      expect(missing).toEqual([]);

      // Instantiation throws because of the start-function gap, not a LinkError.
      let caught: unknown;
      try {
        await WebAssembly.instantiate(result.binary, imports);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WebAssembly.Exception);
      // Specifically NOT a LinkError — proves the "missing import" theory wrong.
      expect(caught).not.toBeInstanceOf(WebAssembly.LinkError);
    },
  );

  runIfInstalled(
    "compileProject on ESM lodash-es/add.js: validates + exports module shape; start function throws (#1276 + #1291)",
    async () => {
      const result = compileProject("node_modules/lodash-es/add.js", { allowJs: true });
      expect(result.success).toBe(true);

      // Wasm validation passes. Module shape — note `add` and `default` are
      // emitted as Wasm globals (closure references), not function exports,
      // because `createMathOperation(fn, 0)` is an HOF returning a closure.
      // #1276 landed but covers the closure compilation, not the call-site
      // surface for the resulting closure.
      const mod = new WebAssembly.Module(result.binary);
      expect(() => new WebAssembly.Module(result.binary)).not.toThrow();

      // #1291 finding: as with clamp, every import is satisfied; instantiation
      // still throws due to the start-function gap (lodash transitive init).
      const imports = (await import("../../src/runtime.ts")).buildImports(result.imports, undefined, result.stringPool);
      const wasmImports = WebAssembly.Module.imports(mod);
      const missing = wasmImports.filter((w) => {
        const m = (imports as Record<string, Record<string, unknown>>)[w.module];
        return m === undefined || !(w.name in m);
      });
      expect(missing).toEqual([]);

      let caught: unknown;
      try {
        await WebAssembly.instantiate(result.binary, imports);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WebAssembly.Exception);
      expect(caught).not.toBeInstanceOf(WebAssembly.LinkError);
      // Calling exports.add(2,3)===5 is gated on the start-function gap.
    },
  );

  runIfInstalled("ModuleResolver on `lodash-es/identity.js` resolves to the real .js body (resolver fix)", () => {
    const rootDir = path.resolve(".");
    const resolver = new ModuleResolver(rootDir, { allowJs: true });
    const resolved = resolver.resolve("lodash-es/identity.js", path.resolve("dummy.ts"));

    // After the resolver fix: TypeScript's standard module resolver was preferring
    // `@types/lodash-es/.d.ts` declarations over the real `.js` body. ModuleResolver
    // now prefers the real `.js` body so `compileProject` walks the implementation.
    expect(resolved).toMatch(/node_modules[\\/]lodash-es[\\/]identity\.js$/);
    expect(resolved).not.toMatch(/@types/);
  });

  runIfInstalled("resolveAllImports walks real .js bodies, not @types declarations (resolver fix)", () => {
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

    // Post-fix behavior: real .js bodies are walked, @types declarations are not.
    expect(anyRealJs).toBe(true);
    expect(anyTypeDecl).toBe(false);
  });
});
