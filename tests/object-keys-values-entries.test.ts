import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors.map((e) => e.message).join("; "));
  const imps = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imps);
  if (imps.setExports) imps.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

describe("Object.keys/values/entries on Wasm structs", () => {
  // -- Object.keys --
  it("Object.keys returns correct keys for object literal", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        const keys = Object.keys(obj);
        if (keys.length !== 3) return 0;
        if (keys[0] !== 'a') return 10;
        if (keys[1] !== 'b') return 11;
        if (keys[2] !== 'c') return 12;
        return 1;
      }
    `),
    ).toBe(1);
  });

  it("Object.keys works on class instances", async () => {
    expect(
      await run(`
      class Point { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } }
      export function test(): number {
        const p = new Point(10, 20);
        const keys = Object.keys(p);
        if (keys.length !== 2) return 0;
        if (keys[0] !== 'x') return 10;
        if (keys[1] !== 'y') return 11;
        return 1;
      }
    `),
    ).toBe(1);
  });

  it("Object.keys returns empty array for empty object", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj = {};
        return Object.keys(obj).length;
      }
    `),
    ).toBe(0);
  });

  it("Object.keys works through function parameter", async () => {
    expect(
      await run(`
      function getKeys(obj: {a: number, b: number}): string[] {
        return Object.keys(obj);
      }
      export function test(): number {
        const result = getKeys({a: 1, b: 2});
        if (result.length !== 2) return 0;
        if (result[0] !== 'a') return 10;
        return 1;
      }
    `),
    ).toBe(1);
  });

  it("Object.keys works inline (chained .length)", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj = { a: 1 };
        return Object.keys(obj).length;
      }
    `),
    ).toBe(1);
  });

  // -- Object.values --
  it("Object.values returns correct values for object literal", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj = { x: 42, y: 99 };
        const vals = Object.values(obj);
        if (vals.length !== 2) return 0;
        if (vals[0] !== 42) return 10;
        if (vals[1] !== 99) return 11;
        return 1;
      }
    `),
    ).toBe(1);
  });

  it("Object.values works on class instances", async () => {
    expect(
      await run(`
      class Pair { a: number; b: number; constructor(a: number, b: number) { this.a = a; this.b = b; } }
      export function test(): number {
        const p = new Pair(5, 10);
        const vals = Object.values(p);
        if (vals.length !== 2) return 0;
        if (vals[0] !== 5) return 10;
        if (vals[1] !== 10) return 11;
        return 1;
      }
    `),
    ).toBe(1);
  });

  // -- Object.entries --
  it("Object.entries returns correct entries for object literal", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj = { a: 10, b: 20 };
        const entries = Object.entries(obj);
        if (entries.length !== 2) return 0;
        if (entries[0][0] !== 'a') return 10;
        if (entries[0][1] !== 10) return 11;
        if (entries[1][0] !== 'b') return 12;
        if (entries[1][1] !== 20) return 13;
        return 1;
      }
    `),
    ).toBe(1);
  });

  // -- Runtime fallback (any type) with host imports --
  it("Object.keys on any-typed object uses host import", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj: any = { a: 1, b: 2 };
        const keys = Object.keys(obj);
        return keys.length;
      }
    `),
    ).toBe(2);
  });

  it("Object.values on any-typed object uses host import", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj: any = { x: 42 };
        const vals = Object.values(obj);
        return vals.length;
      }
    `),
    ).toBe(1);
  });

  it("Object.entries on any-typed object uses host import", async () => {
    expect(
      await run(`
      export function test(): number {
        const obj: any = { a: 1, b: 2 };
        const entries = Object.entries(obj);
        return entries.length;
      }
    `),
    ).toBe(2);
  });
});
