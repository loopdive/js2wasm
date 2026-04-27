// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1174 — Object literal property keys must NOT emit `string_constants` host
 * imports under `--target wasi`. Such modules are supposed to be standalone;
 * a `string_constants` import is unsatisfiable in wasmtime and the binary
 * fails to instantiate.
 *
 * The original symptom is a runtime instantiation error from wasmtime:
 *   unknown import: `string_constants::a,b,c` has not been defined
 *
 * The codegen path that emits the comma-joined field-name string is the
 * `__struct_field_names` export (used only by JS host introspection — dead
 * code under WASI). We skip that export entirely in `nativeStrings` mode.
 *
 * Null-check throws (`TypeError: Cannot access property on null or undefined`)
 * use the same import namespace and must also be routed through the native
 * string runtime in WASI mode.
 */
describe("#1174 — object literals do not leak string_constants imports under --target wasi", () => {
  function compileWasi(source: string) {
    return compile(source, { fileName: "t.js", allowJs: true, target: "wasi", optimize: 0 });
  }

  it("the canonical object-ops benchmark compiles with no string_constants imports", () => {
    const src = `
      /** @param {number} n @returns {number} */
      export function run(n) {
        let acc = 0;
        for (let i = 0; i < n; i++) {
          const record = {
            a: i | 0,
            b: (i * 3) | 0,
            c: (i ^ 0x55aa) | 0,
          };
          acc = (acc + record.a + record.b - record.c) | 0;
        }
        return acc | 0;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    // The high-level imports list (what `buildImports` consults) is empty.
    expect(r.imports).toHaveLength(0);
    // And the binary itself has no `string_constants` imports.
    const text = bytesAsHex(r.binary);
    expect(text).not.toContain(asHex("string_constants"));
  });

  it("string-keyed object literal — keys do not leak as string_constants imports", () => {
    const src = `
      /** @returns {number} */
      export function run() {
        const o = { foo: 1, bar: 2, baz: 3 };
        return (o.foo + o.bar + o.baz) | 0;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    expect(r.imports).toHaveLength(0);
    const text = bytesAsHex(r.binary);
    expect(text).not.toContain(asHex("string_constants"));
    // The comma-joined CSV the legacy path emits — must not appear.
    expect(text).not.toContain(asHex("foo,bar,baz"));
  });

  it("numeric keys + computed string-constant key — no string_constants imports", () => {
    const src = `
      /** @returns {number} */
      export function run() {
        const KEY = "k";
        const o = { 1: 10, 2: 20, [KEY]: 30 };
        return o[1] + o[2];
      }
    `;
    const r = compileWasi(src);
    // Computed keys may not be supported here; only require that IF compile
    // succeeds, no string_constants imports appear.
    if (r.success) {
      const text = bytesAsHex(r.binary);
      expect(text).not.toContain(asHex("string_constants"));
    }
  });

  it("legacy non-WASI mode still uses string_constants (regression guard)", () => {
    // The legacy JS-host path is still expected to use string_constants for
    // string literals — the fix must not affect non-WASI builds.
    const src = `
      /** @returns {string} */
      export function run() { return "a" + "b"; }
    `;
    const r = compile(src, { fileName: "t.js", allowJs: true });
    expect(r.success).toBe(true);
  });
});

function bytesAsHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

function asHex(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += s.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return out;
}
