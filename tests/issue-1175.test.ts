// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1175 — String `+=` codegen passes wrong-typed args to `__str_flatten` /
 * `concat` failing wasm-validator.
 *
 * Root cause: in nativeStrings mode (auto-on for `--target wasi`), the
 * `compileStringCompoundAssignment` legacy branch was unconditionally
 * routing through `wasm:js-string concat` — and was calling
 * `addStringImports(ctx)` LATE during codegen, which appends 5 host imports
 * without shifting already-emitted module function indices. As a result
 * every previously-emitted `call funcIdx=N` instruction silently retargets
 * to whichever new host import landed at index N, producing nonsense like
 * `call $__str_flatten(i32)` and `call $concat(i32, externref)` that fail
 * wasm validation.
 *
 * Fix: in nativeStrings mode, route string `+=` through the native
 * `__str_concat` helper (ref $AnyString → ref $AnyString) and never call
 * `addStringImports` late.
 */
describe("#1175 — string += under --target wasi produces a valid binary", () => {
  function compileWasi(source: string) {
    return compile(source, { fileName: "t.js", allowJs: true, target: "wasi", optimize: 0 });
  }

  it("simple `text += literal` compiles to a valid binary", async () => {
    const src = `
      /** @returns {number} */
      export function run() {
        let text = "";
        text += "x";
        return text.length;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    // Hand the binary to WebAssembly to confirm validation passes —
    // browser/Node WebAssembly only accepts validated bytes. Failure to
    // validate would throw a CompileError at instantiate-time.
    await WebAssembly.compile(r.binary);
  });

  it("string += inside a loop with charAt — the canonical string-hash kernel", async () => {
    const src = `
      /** @param {number} n @returns {number} */
      export function run(n) {
        const alphabet = "abcdefghijklmnopqrstuvwxyz012345";
        let text = "";
        for (let i = 0; i < n; i++) {
          const a = (i * 13) & 31;
          const b = (a + 7) & 31;
          text += alphabet.charAt(a);
          text += alphabet.charAt(b);
          text += ";";
        }
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
          hash = (hash * 31 + text.charCodeAt(i)) | 0;
        }
        return hash | 0;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    await WebAssembly.compile(r.binary);
  });

  it("string += function-returning-string", async () => {
    const src = `
      /** @returns {number} */
      export function run() {
        function makeChar() { return "z"; }
        let s = "";
        s += makeChar();
        s += makeChar();
        return s.length;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    await WebAssembly.compile(r.binary);
  });

  it("mixed literal and dynamic concat: s += 'literal' + dynamicVar", async () => {
    const src = `
      /** @returns {number} */
      export function run() {
        let s = "";
        const v = "world";
        s += "hello, " + v;
        return s.length;
      }
    `;
    const r = compileWasi(src);
    expect(r.success).toBe(true);
    await WebAssembly.compile(r.binary);
  });

  it("legacy (non-WASI) string += still works — regression guard", async () => {
    const src = `
      export function run(): number {
        let s = "";
        s += "x";
        s += "y";
        return s.length;
      }
    `;
    const r = compile(src, { fileName: "t.ts" });
    expect(r.success).toBe(true);
    await WebAssembly.compile(r.binary);
  });
});
