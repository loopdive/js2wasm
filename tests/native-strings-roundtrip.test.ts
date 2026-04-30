import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

/**
 * Regression test for #1187 — `testRuntime` compile option.
 *
 * When `testRuntime: true` is combined with `nativeStrings: true`, the
 * compiled module exposes two helper exports that JS test code can use
 * to round-trip strings across the JS ↔ Wasm boundary:
 *
 *   - `__test_str_from_externref(externref) -> ref $AnyString`
 *   - `__test_str_to_externref(ref $AnyString) -> externref`
 *
 * These let equivalence tests for native-strings string-typed params
 * call `instance.exports.fn(toNative("hello"))` and read results back
 * with `fromNative(...)`, instead of falling back to inline-literal
 * workarounds.
 *
 * Production builds (no `testRuntime` flag) must not contain these
 * exports — verifying that is part of the suite (acceptance criterion #5).
 */

async function instantiate(src: string, opts: { testRuntime?: boolean; nativeStrings?: boolean } = {}) {
  const r = compile(src, {
    fileName: "t.ts",
    target: "gc",
    nativeStrings: opts.nativeStrings ?? true,
    testRuntime: opts.testRuntime ?? false,
  });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  if (imports.setExports) imports.setExports(instance.exports);
  return { instance, exports: instance.exports as Record<string, unknown> };
}

describe("#1187 — test-runtime native-string coercion helper", () => {
  // A tiny program that touches strings so the native-string subsystem
  // initialises, but doesn't otherwise depend on the bridge exports.
  const STRING_SOURCE = `
    export function identity(s: string): string {
      return s;
    }
  `;

  it("exposes __test_str_from_externref / __test_str_to_externref when testRuntime + nativeStrings", async () => {
    const { exports } = await instantiate(STRING_SOURCE, { testRuntime: true, nativeStrings: true });
    expect(typeof exports.__test_str_from_externref).toBe("function");
    expect(typeof exports.__test_str_to_externref).toBe("function");
  });

  it("production build (no testRuntime) does NOT expose the helpers (zero overhead, criterion #5)", async () => {
    const { exports } = await instantiate(STRING_SOURCE, { testRuntime: false, nativeStrings: true });
    expect(exports.__test_str_from_externref).toBeUndefined();
    expect(exports.__test_str_to_externref).toBeUndefined();
  });

  it("round-trips ASCII strings: fromNative(toNative(s)) === s", async () => {
    const { exports } = await instantiate(STRING_SOURCE, { testRuntime: true, nativeStrings: true });
    const toNative = exports.__test_str_from_externref as (s: string) => unknown;
    const fromNative = exports.__test_str_to_externref as (n: unknown) => string;

    for (const s of ["hello", "world", "abc", "WebAssembly", "the quick brown fox"]) {
      const native = toNative(s);
      expect(fromNative(native)).toBe(s);
    }
  });

  it("round-trips the empty string", async () => {
    const { exports } = await instantiate(STRING_SOURCE, { testRuntime: true, nativeStrings: true });
    const toNative = exports.__test_str_from_externref as (s: string) => unknown;
    const fromNative = exports.__test_str_to_externref as (n: unknown) => string;
    expect(fromNative(toNative(""))).toBe("");
  });

  it("round-trips BMP unicode (non-ASCII, no surrogate pairs)", async () => {
    const { exports } = await instantiate(STRING_SOURCE, { testRuntime: true, nativeStrings: true });
    const toNative = exports.__test_str_from_externref as (s: string) => unknown;
    const fromNative = exports.__test_str_to_externref as (n: unknown) => string;

    // Latin-1, Greek, Cyrillic, CJK, mixed
    const cases = [
      "café",
      "naïve",
      "Ωμέγα",
      "Привет",
      "你好",
      "日本語",
      "Hello 世界 🚀".replace(/[\uD800-\uDFFF]/g, ""), // strip emoji surrogates — BMP only
      "ÿĀሴ￾",
    ];
    for (const s of cases) {
      const native = toNative(s);
      expect(fromNative(native)).toBe(s);
    }
  });

  it("the helpers can be passed as args to user functions", async () => {
    const { exports } = await instantiate(
      `
        export function identity(s: string): string {
          return s;
        }
      `,
      { testRuntime: true, nativeStrings: true },
    );
    const toNative = exports.__test_str_from_externref as (s: string) => unknown;
    const fromNative = exports.__test_str_to_externref as (n: unknown) => string;
    const identity = exports.identity as (n: unknown) => unknown;

    const result = identity(toNative("hello"));
    expect(fromNative(result)).toBe("hello");
  });

  it("testRuntime is a no-op when nativeStrings is off", async () => {
    // testRuntime piggy-backs on the native-string bridge, so when
    // nativeStrings is false there's nothing to bridge — the helpers
    // should be absent rather than referencing nonexistent types.
    const { exports } = await instantiate(STRING_SOURCE, { testRuntime: true, nativeStrings: false });
    expect(exports.__test_str_from_externref).toBeUndefined();
    expect(exports.__test_str_to_externref).toBeUndefined();
  });
});
