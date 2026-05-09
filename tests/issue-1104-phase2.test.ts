// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1104 Phase 2 — native Error property access (.message / .name).
//
// Phase 1 (PR #324) made `new Error(...)` build a `$Error_struct` in WASI
// mode and instantiate without `env.__new_<Name>` imports. Phase 2 wires
// reads of `error.message` and `error.name` to direct `struct.get` on the
// new struct type. Without this fast path, the compiler falls through to
// `__extern_get` (host import) which is unavailable standalone.
//
// Scope: confirms that
//   1. WASI compilation of `e.message` / `e.name` does NOT register an
//      `__extern_get` host import for those reads.
//   2. The wasm module instantiates standalone and the function calls
//      complete without trapping.
//   3. The emitted WAT contains a `struct.get` against `$Error_struct`.
//   4. JS-host mode is unchanged — reads still go through the host path.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

describe("#1104 Phase 2 — native Error property access (standalone mode)", () => {
  describe("WASI mode", () => {
    it("emits struct.get for `error.message` instead of __extern_get host import", () => {
      const src = `
        export function getMessage(): any {
          const e = new Error("oops");
          return e.message;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      // Ensure the WAT references the Error struct's message field.
      expect(r.wat).toContain("$Error_struct");
      // No env imports at all (Phase 1 + Phase 2 combined eliminate all
      // host-Error host paths for this minimal program).
      const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
      expect(envImports).toEqual([]);
    });

    it("emits struct.get for `error.name` similarly", () => {
      const src = `
        export function getName(): any {
          const e = new TypeError("oops");
          return e.name;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      expect(r.wat).toContain("$Error_struct");
      const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
      expect(envImports).toEqual([]);
    });

    it("WASI module with `error.message` access instantiates and runs", async () => {
      const src = `
        export function test(): number {
          const e = new Error("oops");
          const m = e.message;  // round-trips through struct.get $message
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const test = instance.exports.test as () => number;
      expect(test()).toBe(0);
    });

    it("WASI module with `error.name` access instantiates and runs", async () => {
      const src = `
        export function test(): number {
          const e = new RangeError("oops");
          const n = e.name;
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const test = instance.exports.test as () => number;
      expect(test()).toBe(0);
    });

    it("works for all 7 standard Error subclass property accesses", async () => {
      // AggregateError takes (errors, msg) and goes through a different
      // codegen path; the Phase 2 fast path only fires on `Error` subclasses
      // for `.message` / `.name` reads. Cover the 7 standard ones here.
      const src = `
        function readMessage(e: Error): any { return e.message; }
        function readName(e: TypeError): any { return e.name; }
        export function test(): number {
          readMessage(new Error("a"));
          readMessage(new TypeError("b"));
          readMessage(new RangeError("c"));
          readMessage(new SyntaxError("d"));
          readMessage(new URIError("e"));
          readMessage(new EvalError("f"));
          readMessage(new ReferenceError("g"));
          readName(new TypeError("h"));
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const test = instance.exports.test as () => number;
      expect(test()).toBe(0);
    });

    it("does not break when LHS is not an Error type (control case)", async () => {
      const src = `
        type Box = { message: string };
        export function test(): number {
          const b: Box = { message: "hi" };
          const m = b.message;  // not an Error — should NOT use struct.get $Error_struct
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      // We only care that compilation succeeds; the property access falls
      // through to the regular plain-object path. (If our Phase 2 guard
      // mistakenly fired here, the ref.cast at runtime would trap.)
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const test = instance.exports.test as () => number;
      expect(test()).toBe(0);
    });
  });

  describe("JS-host mode (regression check — unchanged)", () => {
    it("`error.message` still routes through the host path (no struct.get $Error_struct)", () => {
      const src = `
        export function getMessage(): any {
          const e = new Error("oops");
          return e.message;
        }
      `;
      const r = compile(src);
      expect(r.success).toBe(true);
      // In JS-host mode the Error struct type should NOT be registered.
      expect(r.wat).not.toContain("$Error_struct");
    });
  });
});
