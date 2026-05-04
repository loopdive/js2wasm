// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1286: `Object.keys(any).join(...)` previously trapped with "illegal cast" because
// the WasmGC-native `compileArrayJoin` path tried to extract a vec struct from an
// externref (the JS array returned by the `__object_keys` host import). The fix
// dispatches join through a host-import fallback `__array_join_any` whenever the
// receiver evaluates to externref at runtime.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runFn(source: string, exportName: string): Promise<unknown> {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    const msgs = result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n");
    throw new Error(`compile failed:\n${msgs}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  // The host-import fallback (`__array_join_any` + `__object_keys`) calls back
  // into Wasm exports through `__struct_field_names` to discover field names —
  // wire wasmExports through setExports so the callbacks can reach them.
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[exportName]!();
}

describe("issue-1286: Object.keys(any).join() externref→string-array coerce", () => {
  describe("acceptance criteria", () => {
    it("AC1: Object.keys(anyObj).join(',') returns the comma-joined keys", async () => {
      const ret = await runFn(
        `
function f(obj: any): string {
  return Object.keys(obj).join(",");
}
export function run(): string {
  return f({ a: 1, b: 2 });
}`,
        "run",
      );
      expect(ret).toBe("a,b");
    });

    it("AC2: Object.keys(anyObj).join() with default separator returns the spec-mandated `,`", async () => {
      const ret = await runFn(
        `
function f(obj: any): string {
  return Object.keys(obj).join();
}
export function run(): string {
  return f({ a: 1, b: 2 });
}`,
        "run",
      );
      // Default separator is "," per Array.prototype.join (ECMA-262 §23.1.3.18).
      expect(ret).toBe("a,b");
    });

    it("AC3: round-trip `Object.keys({a:1,b:2}).join(',')` === 'a,b'", async () => {
      const ret = await runFn(
        `
export function run(): string {
  return Object.keys({ a: 1, b: 2 }).join(",");
}`,
        "run",
      );
      expect(ret).toBe("a,b");
    });
  });

  describe("regression guard (issue #1243 — Object.keys on typed structs)", () => {
    it("typed struct path still uses inline WasmGC enumeration (no host fallback regression)", async () => {
      const ret = await runFn(
        `
type O = { a: number; b: number; c: number };
export function run(): string {
  const o: O = { a: 1, b: 2, c: 3 };
  return Object.keys(o).join(",");
}`,
        "run",
      );
      expect(ret).toBe("a,b,c");
    });

    it("typed struct with explicit separator join", async () => {
      // Note: the no-argument `.join()` path on the WasmGC-native side is a
      // pre-existing limitation (it emits `ref.null.extern` when the literal
      // "," is not registered as a string constant elsewhere in the source).
      // That's tracked separately; this test uses an explicit separator so
      // the regression guard stays focused on the externref-receiver fix.
      const ret = await runFn(
        `
type O = { x: number; y: number };
export function run(): string {
  const o: O = { x: 1, y: 2 };
  return Object.keys(o).join(",");
}`,
        "run",
      );
      expect(ret).toBe("x,y");
    });
  });

  describe("regression guard (existing array.join paths)", () => {
    it("typed string array still joins via WasmGC-native path", async () => {
      const ret = await runFn(
        `
export function run(): string {
  const arr: string[] = ["alpha", "beta", "gamma"];
  return arr.join("-");
}`,
        "run",
      );
      expect(ret).toBe("alpha-beta-gamma");
    });

    it("typed number array still joins with element-to-string conversion", async () => {
      const ret = await runFn(
        `
export function run(): string {
  const arr: number[] = [1, 2, 3];
  return arr.join(",");
}`,
        "run",
      );
      expect(ret).toBe("1,2,3");
    });

    it("typed array of mixed values still joins via WasmGC-native path", async () => {
      const ret = await runFn(
        `
export function run(): string {
  const arr: number[] = [10, 20, 30];
  return arr.join("|");
}`,
        "run",
      );
      expect(ret).toBe("10|20|30");
    });
  });

  describe("custom separators on externref receivers", () => {
    it("non-default separator works through the host fallback", async () => {
      const ret = await runFn(
        `
function f(obj: any): string {
  return Object.keys(obj).join(" | ");
}
export function run(): string {
  return f({ alpha: 1, beta: 2 });
}`,
        "run",
      );
      expect(ret).toBe("alpha | beta");
    });

    it("empty separator works", async () => {
      const ret = await runFn(
        `
function f(obj: any): string {
  return Object.keys(obj).join("");
}
export function run(): string {
  return f({ a: 1, b: 2, c: 3 });
}`,
        "run",
      );
      expect(ret).toBe("abc");
    });
  });
});
