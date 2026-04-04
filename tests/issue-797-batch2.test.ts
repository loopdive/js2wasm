/**
 * Tests for #797 WI3 (Object.getOwnPropertyNames/Symbols) and WI6 (Object.create with descriptors)
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runWasm(src: string): Promise<any> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) throw new Error(result.errors[0]?.message ?? "CE");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as any).test();
}

describe("#797 WI3: Object.getOwnPropertyNames", () => {
  it("returns own string keys of a plain object", async () => {
    const ret = await runWasm(`
      class Obj { x: number = 1; y: number = 2; }
      export function test(): number {
        var obj: any = new Obj();
        var names: any = Object.getOwnPropertyNames(obj as any);
        if (names === null || names === undefined) return 2;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("uses __getOwnPropertyNames host import for dynamic objects", async () => {
    const ret = await runWasm(`
      export function test(): number {
        var obj: any = {} as any;
        var names: any = Object.getOwnPropertyNames(obj as any);
        if (names === null || names === undefined) return 2;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Object.getOwnPropertySymbols returns array for dynamic objects", async () => {
    const ret = await runWasm(`
      export function test(): number {
        var obj: any = {} as any;
        var syms: any = Object.getOwnPropertySymbols(obj as any);
        if (syms === null || syms === undefined) return 2;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });
});

describe("#797 WI6: Object.getPrototypeOf for dynamic objects", () => {
  it("Object.getPrototypeOf works for Object.create result", async () => {
    const ret = await runWasm(`
      export function test(): number {
        var proto: any = {} as any;
        var obj: any = Object.create(proto as any);
        var p: any = Object.getPrototypeOf(obj as any);
        if (p !== proto) return 2;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Object.create with literal descriptors sets properties", async () => {
    const ret = await runWasm(`
      export function test(): number {
        var d: any = Object.create({} as any, {"x": {value: 42 as any, writable: false, enumerable: true, configurable: true}});
        if ((d as any).x !== 42) return 2;
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });
});
