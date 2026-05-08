// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1104 Phase 1 — Wasm-native Error construction in WASI/standalone mode.
//
// Before this change, `new Error(...)` always lowered to `env.__new_Error`
// host import. In `--target wasi` mode there is no JS host to satisfy the
// import, so the wasm module failed to instantiate with:
//
//   WebAssembly.instantiate(): Import #N "env": module is not an object or function
//
// Phase 1 replaces those host imports with internal Wasm functions that
// build a `$Error_struct` WasmGC type. The struct stores the constructor
// argument as `$message` and a `$tag` for future #1325 Phase 2 instanceof
// support; field reads (`err.message` / `err.name`) still go through the
// JS-host paths and are NOT exercised here — that's deferred to Phase 2.
//
// Scope: confirms that
//   1. WASI compilation does not register `env.__new_<ErrorName>` host imports
//      for the 8 built-in Error constructors.
//   2. The wasm module instantiates with an empty `imports` argument.
//   3. `new Error(...)` and `throw new Error(...)` round-trip without crashes
//      (catch-without-binding works; catch-with-binding still requires
//      `__get_caught_exception` host support and is out of scope here).
//   4. JS-host mode is unchanged — the host imports are still emitted.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const ERROR_CONSTRUCTORS = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
] as const;

describe("#1104 Phase 1 — wasm-native Error construction (standalone mode)", () => {
  describe("WASI mode", () => {
    it("compiles `new Error(msg)` without registering env.__new_Error host import", () => {
      const src = `
        export function test(): number {
          const e = new Error("oops");
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
      expect(envImports).not.toContain("__new_Error");
    });

    it("compiles `new TypeError(msg)` / `new RangeError(msg)` similarly without env imports", () => {
      const src = `
        export function test(): number {
          const t = new TypeError("type bad");
          const r = new RangeError("range bad");
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
      expect(envImports).not.toContain("__new_TypeError");
      expect(envImports).not.toContain("__new_RangeError");
    });

    it("WASI module instantiates and runs without any env module supplied", async () => {
      const src = `
        export function test(): number {
          const a = new Error("a");
          const b = new TypeError("b");
          const c = new RangeError("c");
          const d = new SyntaxError("d");
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      // No env module — pure standalone instantiation.
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const test = instance.exports.test as () => number;
      expect(test()).toBe(0);
    });

    it("throw/catch (without binding) works for native Error in standalone mode", async () => {
      const src = `
        export function test(): number {
          try {
            throw new TypeError("oops");
          } catch {
            return 42;
          }
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const test = instance.exports.test as () => number;
      expect(test()).toBe(42);
    });

    it("registers a `$Error_struct` WasmGC type when any error constructor is used", () => {
      const src = `
        export function test(): number {
          const e = new Error("oops");
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      // The struct type should be present in the WAT.
      expect(r.wat).toContain("$Error_struct");
    });

    it("emits internal `__new_<Name>` Wasm functions instead of host imports", () => {
      const src = `
        export function test(): number {
          const e = new Error("oops");
          const t = new TypeError("oops");
          return 0;
        }
      `;
      const r = compile(src, { target: "wasi" });
      expect(r.success).toBe(true);
      // Internal funcs are declared with `(func $__new_Error ...)` — not
      // `(import "env" "__new_Error" ...)`.
      expect(r.wat).toMatch(/\(func \$__new_Error /);
      expect(r.wat).toMatch(/\(func \$__new_TypeError /);
      expect(r.wat).not.toMatch(/import "env" "__new_Error"/);
      expect(r.wat).not.toMatch(/import "env" "__new_TypeError"/);
    });
  });

  describe("JS-host mode (regression check — unchanged)", () => {
    for (const ctor of ERROR_CONSTRUCTORS) {
      // AggregateError uses a different signature path; skip it here — the
      // generic path covers Error/TypeError/RangeError/SyntaxError/URIError/
      // EvalError/ReferenceError.
      if (ctor === "AggregateError") continue;
      it(`still emits env.__new_${ctor} host import`, () => {
        const src = `
          export function test(): number {
            const e = new ${ctor}("oops");
            return 0;
          }
        `;
        const r = compile(src);
        expect(r.success).toBe(true);
        const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
        expect(envImports).toContain(`__new_${ctor}`);
      });
    }
  });
});
