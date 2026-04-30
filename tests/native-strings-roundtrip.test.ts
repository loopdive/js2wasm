// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1187 — Test-runtime native-string -> JS-string coercion helpers.
//
// When `nativeStrings: true` is set, a Wasm export with a `string` parameter
// has the Wasm signature `(ref $AnyString) -> ...`. JS callers cannot pass a
// JS string in directly because the JS engine auto-coerces JS strings to
// `externref`, not to a `(ref $AnyString)` struct.
//
// The `testRuntime: true` compile option emits two extra Wasm exports that
// solve this for tests:
//
//   __test_str_from_externref(externref) -> (ref $AnyString)
//     Walks the JS string char-by-char and builds a fresh `$NativeString`.
//
//   __test_str_to_externref((ref $AnyString)) -> externref
//     Flattens to `$NativeString`, then builds a JS string by accumulating
//     `String.fromCharCode(c)` chars via `wasm:js-string.concat`.
//
// Production builds (without `testRuntime`) must NOT include these exports.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

interface Helpers {
  toNative: (s: string) => unknown;
  fromNative: (s: unknown) => string;
  exports: Record<string, unknown>;
}

async function compileAndInstantiate(source: string, options: { testRuntime?: boolean } = {}): Promise<Helpers> {
  const r = compile(source, {
    nativeStrings: true,
    testRuntime: options.testRuntime ?? true,
    fileName: "test.ts",
  });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  const exports = instance.exports as Record<string, unknown>;
  built.setExports?.(exports as Record<string, Function>);
  const toNativeFn = exports.__test_str_from_externref as ((s: string) => unknown) | undefined;
  const fromNativeFn = exports.__test_str_to_externref as ((s: unknown) => string) | undefined;
  return {
    toNative: (s) => {
      if (typeof toNativeFn !== "function") {
        throw new Error("__test_str_from_externref export missing");
      }
      return toNativeFn(s);
    },
    fromNative: (s) => {
      if (typeof fromNativeFn !== "function") {
        throw new Error("__test_str_to_externref export missing");
      }
      return fromNativeFn(s);
    },
    exports,
  };
}

describe("#1187 native-strings test runtime — round-trip helpers", () => {
  // A trivial program that exposes a string-typed export. With nativeStrings,
  // its Wasm signature has a `(ref $AnyString)` param/result, so passing a JS
  // string directly throws — this is exactly what the test helpers fix.
  const SRC = "export function identity(s: string): string { return s; }";

  it("round-trips ASCII through fromNative(toNative(s))", async () => {
    const h = await compileAndInstantiate(SRC);
    expect(h.fromNative(h.toNative("hello"))).toBe("hello");
  });

  it("round-trips the empty string", async () => {
    const h = await compileAndInstantiate(SRC);
    expect(h.fromNative(h.toNative(""))).toBe("");
  });

  it("round-trips BMP unicode (single-code-unit chars)", async () => {
    const h = await compileAndInstantiate(SRC);
    // All these are single 16-bit code units (no surrogates):
    //   eacute U+00E9, ntilde U+00F1, lambda U+03BB, hiragana-a U+3042
    const s = "héllo ñ λ あ";
    expect(h.fromNative(h.toNative(s))).toBe(s);
  });

  it("round-trips a string of length 1", async () => {
    const h = await compileAndInstantiate(SRC);
    expect(h.fromNative(h.toNative("X"))).toBe("X");
  });

  it("passes a JS string into a Wasm export whose param is a native string", async () => {
    // The compiler emits `identity(s: string)` with signature
    // `(ref $AnyString) -> (ref $AnyString)` in nativeStrings mode. Without
    // the helpers, calling `identity("hi")` would throw a type-incompatibility
    // error; with them, we coerce in and back out.
    const h = await compileAndInstantiate(SRC);
    const identity = h.exports.identity as ((s: unknown) => unknown) | undefined;
    expect(typeof identity).toBe("function");
    const result = identity!(h.toNative("round-trip!"));
    expect(h.fromNative(result)).toBe("round-trip!");
  });

  it("does NOT emit the helpers when testRuntime is unset (zero overhead)", async () => {
    const r = compile(SRC, { nativeStrings: true, fileName: "test.ts" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    const exports = instance.exports as Record<string, unknown>;
    expect(exports.__test_str_from_externref).toBeUndefined();
    expect(exports.__test_str_to_externref).toBeUndefined();
  });

  it("does NOT emit the helpers when nativeStrings is unset (testRuntime alone is a no-op)", async () => {
    // testRuntime without nativeStrings is meaningless — the helpers only
    // make sense for native-string param types. Setting testRuntime in
    // non-native mode does nothing.
    const r = compile(SRC, { testRuntime: true, fileName: "test.ts" });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const built = buildImports(r.imports, ENV_STUB, r.stringPool);
    const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
    const exports = instance.exports as Record<string, unknown>;
    expect(exports.__test_str_from_externref).toBeUndefined();
    expect(exports.__test_str_to_externref).toBeUndefined();
  });
});
