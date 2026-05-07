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
   * Tier 2b — `flow.js`: composes an array of functions via reduce. Was
   * failing Wasm VALIDATION with "Invalid global index: 266 @+117088" because
   * `fixupModuleGlobalIndices` over-shifted nested instr arrays that were
   * reachable from multiple top-level body paths (#1302). Fixed by deduping
   * shifts per fixup call via a WeakSet of visited instructions.
   */
  runIfInstalled("Tier 2b flow — compiles + validates (#1302 fix)", async () => {
    const result = compileProject("node_modules/lodash-es/flow.js", { allowJs: true });
    expect(result.success).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  /**
   * Tier 2c — `partial.js`: partial application via closure capture.
   * Previously failed Wasm validation in `mergeData` with:
   *   "f64.trunc[0] expected type f64, found global.get of type externref"
   * Root-caused (#1303 / #1305) to a leak in `fixupModuleGlobalIndices`:
   * recursively-shifted nested bodies were not added to the per-call
   * `shifted` set, so duplicate `savedBodies` entries caused the same
   * `global.get` instructions inside an `||` / `&&` side-buffer to be
   * shifted multiple times. The over-shift drove a numeric global-get
   * past the last numeric module global into the externref tail of the
   * global table, so the legacy `compileBitwiseBinaryOp` site (which
   * had emitted `f64.trunc` against what was f64 at compile time) ended
   * up validating against an externref operand at link time.
   */
  runIfInstalled("Tier 2c partial — compiles + validates after #1303/#1305 fix", async () => {
    const result = compileProject("node_modules/lodash-es/partial.js", { allowJs: true });
    expect(result.success).toBe(true);
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
   * Tier 2d-call — passing a JS predicate to negate. The `typeof
   * predicate != 'function'` guard inside lodash that originally fired
   * is now fixed (#1304), so `negate(jsFn)` returns successfully. But
   * the returned value is a Wasm closure struct, which appears to JS
   * callers as `[Object: null prototype] {}` — `typeof negated` is
   * `"object"` and `negated(2)` throws "is not a function".
   *
   * Wasm closures returned across the JS/Wasm boundary need a wrapper
   * (or the runtime needs to inject a JS-callable proxy). Tracked in
   * follow-up #1308.
   */
  runIfInstalled(
    "Tier 2d negate(jsFn) — typeof guard no longer throws, but result is not JS-callable (#1308)",
    async () => {
      const result = compileProject("node_modules/lodash-es/negate.js", { allowJs: true });
      const buildImports = (await import("../../src/runtime.ts")).buildImports;
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      const exports = instance.exports as Record<string, Function>;

      // #1304 fix: lodash's typeof guard no longer fires — negate returns
      // without throwing. Pre-#1304 this threw "TypeError: Expected a function".
      const isEven = (n: number) => n % 2 === 0;
      let negated: unknown;
      let threw = false;
      try {
        negated = exports.negate(isEven);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(negated).not.toBeUndefined();
      expect(negated).not.toBeNull();

      // What's missing (#1308): the Wasm closure struct is NOT a callable
      // JS function — `typeof negated` is "object", and direct invocation
      // throws. We document this gap by asserting the current behavior; the
      // test will start failing once #1308 lands a JS-callable wrapper.
      expect(typeof negated).toBe("object");
    },
  );
});
