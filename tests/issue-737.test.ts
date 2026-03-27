/**
 * Issue #737: undefined handling edge cases
 *
 * Wasm ref.null.extern maps to JS null, not undefined. Tests checking
 * typeof x === 'undefined' or x === undefined fail because the compiler
 * lacked __typeof_undefined, __typeof_object, and __typeof_function
 * host import helpers for externref-typed values.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string, ...args: any[]): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test(...args);
}

describe("Issue #737: undefined handling edge cases", () => {
  it("typeof x === 'undefined' for any-typed undefined variable", async () => {
    const src = `
      export function test(): number {
        let x: any = undefined;
        if (typeof x === 'undefined') return 1;
        return 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("typeof x !== 'undefined' for non-undefined value", async () => {
    const src = `
      export function test(): number {
        let x: any = 42;
        if (typeof x !== 'undefined') return 1;
        return 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("x === undefined with externref parameter", async () => {
    const src = `
      export function test(x: any): number {
        if (x === undefined) return 1;
        return 0;
      }
    `;
    expect(await run(src, undefined)).toBe(1);
    expect(await run(src, null)).toBe(0);
    expect(await run(src, 42)).toBe(0);
  });

  it("null !== undefined strict equality", async () => {
    const src = `
      export function test(): number {
        let x: any = null;
        if (x === undefined) return 0;
        return 1;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("typeof null === 'object'", async () => {
    const src = `
      export function test(): number {
        let x: any = null;
        if (typeof x === 'object') return 1;
        return 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("typeof x == 'undefined' (loose equality)", async () => {
    const src = `
      export function test(): number {
        let x: any = undefined;
        if (typeof x == 'undefined') return 1;
        return 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("null == undefined (loose equality)", async () => {
    const src = `
      export function test(): number {
        let x: any = null;
        if (x == undefined) return 1;
        return 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
