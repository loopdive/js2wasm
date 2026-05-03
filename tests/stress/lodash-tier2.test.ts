// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1292 — lodash Tier 2 stress test: memoize, flow, partial, negate.
//
// Tier 1 (`tests/stress/lodash-tier1.test.ts`) covered identity / add / clamp
// at the function-compilation level. Tier 2 lifts the floor to higher-order
// patterns: memoize closes over a Map cache, flow composes an array of
// functions via reduce, partial captures a leading argument, negate wraps a
// predicate in a !-flipping closure.
//
// As with Tier 1, each tier is a probe — failing tiers document specific
// compiler gaps as follow-up issues, marked with `it.skip` + issue refs,
// rather than blocking the whole file.

import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compileProject } from "../../src/index.js";

const lodashEsInstalled = existsSync("node_modules/lodash-es/memoize.js");
const runIfInstalled = lodashEsInstalled ? it : it.skip;

describe("#1292 lodash Tier 2 stress test — memoize, flow, partial, negate", () => {
  /**
   * Tier 2a — `memoize.js`: HOF that captures a `Map`-backed cache via
   * closure. The compiled module passes Wasm validation, exports `memoize`
   * + `default` as functions, and every Wasm import is satisfied by
   * `buildImports`. Instantiation throws a `WebAssembly.Exception` from
   * the start function — same pattern as Tier 1's `clamp` / `add`
   * (lodash's transitive feature-detection deps run at module init and
   * fail). Tracked under #1295 on the start-function side.
   */
  runIfInstalled(
    "Tier 2a memoize — compiles, validates, all imports satisfied; start function throws (#1295)",
    async () => {
      const result = compileProject("node_modules/lodash-es/memoize.js", { allowJs: true });
      expect(result.success).toBe(true);

      const mod = new WebAssembly.Module(result.binary);
      const exports = WebAssembly.Module.exports(mod);
      const funcNames = exports.filter((e) => e.kind === "function").map((e) => e.name);
      expect(funcNames).toContain("memoize");
      expect(funcNames).toContain("default");

      const buildImports = (await import("../../src/runtime.ts")).buildImports;
      const imports = buildImports(result.imports, undefined, result.stringPool);
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
      // Same start-function gap as Tier 1's clamp/add. NOT a LinkError
      // (proves "missing import" is not the cause).
      expect(caught).toBeInstanceOf(WebAssembly.Exception);
      expect(caught).not.toBeInstanceOf(WebAssembly.LinkError);
    },
  );

  /**
   * Tier 2b — `flow.js`: composes an array of functions via reduce. The
   * compiled module fails Wasm VALIDATION (not instantiation) with:
   *   "Compiling function #945:\"__closure_837\" failed:
   *    Invalid global index: 266 @+117088"
   * The compiler emits a closure that references a global index past the
   * declared range. Probably a global-index allocation issue when many
   * closures (lodash has hundreds in the transitive graph) compete for the
   * same global table. Tracked as **#1302**.
   */
  it.skip("Tier 2b flow — closure references invalid global index, fails Wasm validation (#1302)", async () => {
    const result = compileProject("node_modules/lodash-es/flow.js", { allowJs: true });
    expect(result.success).toBe(true);
    // Currently throws synchronously from `new WebAssembly.Module(...)`:
    //   "Invalid global index: 266 @+117088"
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  /**
   * Tier 2c — `partial.js`: partial application via closure capture. The
   * compiled module fails Wasm VALIDATION with:
   *   "Compiling function #94:\"mergeData\" failed:
   *    f64.trunc[0] expected type f64, found global.get of type externref @+36700"
   * The codegen for `mergeData` emits an `f64.trunc` whose operand is a
   * global of type externref instead of f64 — likely a missing externref→f64
   * unbox before a numeric op in the lodash internals. Tracked as **#1303**.
   */
  it.skip("Tier 2c partial — f64.trunc emitted on externref operand, fails Wasm validation (#1303)", async () => {
    const result = compileProject("node_modules/lodash-es/partial.js", { allowJs: true });
    expect(result.success).toBe(true);
    // Currently throws:
    //   "f64.trunc[0] expected type f64, found global.get of type externref"
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  /**
   * Tier 2d — `negate.js`: returns a closure that wraps a predicate.
   * Compiles, validates, instantiates, AND exports `negate` + `default`
   * as callable functions. This is the furthest any lodash module has
   * progressed in the stress-test ladder.
   *
   * The compile + instantiate path is fully exercised here (criterion
   * passes). Calling `negate(jsFunction)` throws a `TypeError: Expected
   * a function` because lodash's own `typeof predicate != 'function'`
   * guard fires — the runtime returns `"object"` for an externref
   * wrapping a JS function instead of `"function"`. That's a separate
   * runtime/typeof gap tracked as **#1304** (related to existing #1275
   * `typeof guard narrowing for any`). Skipped pending #1304.
   */
  runIfInstalled("Tier 2d negate — compiles, validates, instantiates, exports negate + default", async () => {
    const result = compileProject("node_modules/lodash-es/negate.js", { allowJs: true });
    expect(result.success).toBe(true);

    const mod = new WebAssembly.Module(result.binary);
    const funcNames = WebAssembly.Module.exports(mod)
      .filter((e) => e.kind === "function")
      .map((e) => e.name);
    expect(funcNames).toContain("negate");
    expect(funcNames).toContain("default");

    const buildImports = (await import("../../src/runtime.ts")).buildImports;
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const wasmImports = WebAssembly.Module.imports(mod);
    const missing = wasmImports.filter((w) => {
      const m = (imports as Record<string, Record<string, unknown>>)[w.module];
      return m === undefined || !(w.name in m);
    });
    expect(missing).toEqual([]);

    // Instantiation succeeds — start function returns cleanly. negate
    // has no transitive feature-detection deps that throw at init.
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, Function>;
    expect(typeof exports.negate).toBe("function");
    expect(typeof exports.default).toBe("function");
  });

  /**
   * Tier 2d-call — passing a JS predicate to negate currently throws
   * because lodash's `typeof predicate != 'function'` guard fires:
   * the runtime classifies an externref-wrapped JS function as
   * `"object"`, not `"function"`. Tracked as **#1304**.
   */
  it.skip("Tier 2d negate(jsFn) — typeof externref returns wrong category (#1304)", async () => {
    const result = compileProject("node_modules/lodash-es/negate.js", { allowJs: true });
    const buildImports = (await import("../../src/runtime.ts")).buildImports;
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const exports = instance.exports as Record<string, Function>;

    const isEven = (n: number) => n % 2 === 0;
    const negated = exports.negate(isEven);
    expect(typeof negated).toBe("function");
    expect((negated as (n: number) => boolean)(2)).toBe(false);
    expect((negated as (n: number) => boolean)(3)).toBe(true);
  });
});
