// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1111 — Wrapper object constructors: new Number/String/Boolean
 *
 * Exercises the JS spec rules for Number/String/Boolean OBJECT wrappers:
 *  - `typeof new Number(x) === "object"` (NOT "number")
 *  - `+wrapper` → unbox via valueOf
 *  - `!!wrapper` → always `true` (even `new Boolean(false)` / `new Number(0)` / `new String("")`)
 *  - `wrapper == primitive` → loose eq, unbox wrapper via ToPrimitive, then compare
 *  - `wrapper === primitive` → always `false` (different JS types; wrapper is "object")
 *  - `wrapperA === wrapperB` → reference identity (two `new Number(42)` are different objects)
 *
 * Uses inferred TypeScript types — `var x = new Number(n)` infers `x` as the
 * `Number` wrapper type (capital N), which is how test262 JS files look to TSC.
 * (`as unknown as number` casts erase wrapper info and fall outside this fix.)
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string, entry = "test"): Promise<unknown> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error("compile failed: " + r.errors.map((e) => e.message).join("; "));
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => unknown>)[entry]!();
}

describe("Issue #1111 — wrapper object constructors", () => {
  it("typeof new Number(n) === 'object'", async () => {
    const src = `export function test(): boolean { return typeof (new Number(42)) === "object"; }`;
    expect(await run(src)).toBe(1);
  });

  it("typeof new String(s) === 'object'", async () => {
    const src = `export function test(): boolean { return typeof (new String("x")) === "object"; }`;
    expect(await run(src)).toBe(1);
  });

  it("typeof new Boolean(b) === 'object'", async () => {
    const src = `export function test(): boolean { return typeof (new Boolean(false)) === "object"; }`;
    expect(await run(src)).toBe(1);
  });

  it("+new Number(42) === 42 (valueOf unbox)", async () => {
    const src = `export function test(): boolean { return +(new Number(42)) === 42; }`;
    expect(await run(src)).toBe(1);
  });

  it("!!wrapper is always true (even for falsy primitives)", async () => {
    const src = `
      export function test(): boolean {
        return !!(new Boolean(false)) === true &&
               !!(new Number(0)) === true &&
               !!(new String("")) === true;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("strict equality: wrapper !== primitive (different types)", async () => {
    const src = `
      export function test(): boolean {
        var a = new Number(42);
        var b = new String("x");
        var c = new Boolean(true);
        return (a !== 42 as any) && (b !== "x" as any) && (c !== true as any);
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("strict equality: wrapper === primitive is always false", async () => {
    const src = `
      export function test(): boolean {
        var a = new Number(42);
        var b = new String("x");
        var c = new Boolean(true);
        return ((a === 42 as any) === false) &&
               ((b === "x" as any) === false) &&
               ((c === true as any) === false);
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("loose equality: wrapper == primitive triggers ToPrimitive on wrapper", async () => {
    const src = `
      export function test(): boolean {
        var a = new Number(42);
        var b = new String("x");
        var c = new Boolean(true);
        return (a == 42 as any) && (b == "x" as any) && (c == true as any);
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("strict equality: two wrappers with same value are different objects", async () => {
    const src = `
      export function test(): boolean {
        var a = new Number(42);
        var b = new Number(42);
        return (a === b) === false;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("loose equality: two wrappers with same value are different objects (==)", async () => {
    const src = `
      export function test(): boolean {
        var a = new String("x");
        var b = new String("x");
        return (a == b) === false;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("strict equality: same wrapper reference is equal", async () => {
    const src = `
      export function test(): boolean {
        var a = new Number(42);
        var b = a;
        return (a === b) === true;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("regression: string primitive == string primitive still uses content equality", async () => {
    const src = `
      export function test(): boolean {
        var a = "hello";
        var b = "hello";
        return (a === b) === true && (a == b) === true;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("regression: number primitive == number primitive still uses value equality", async () => {
    const src = `
      export function test(): boolean {
        var a = 42;
        var b = 42;
        return (a === b) === true && (a == b) === true;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
