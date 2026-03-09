import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<any> {
  const result = compile(source, { fileName: "test.ts" });
  if (result.errors.some(e => e.severity === "error")) {
    throw new Error(result.errors.map(e => e.message).join("; "));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test();
}

describe("externref compound assignment", () => {
  it("var x; x = 1; x *= -1", async () => {
    const ret = await run(`
      export function test(): number {
        var x: any;
        x = 1;
        x *= -1;
        return x;
      }
    `);
    expect(ret).toBe(-1);
  });

  it("var x; x = -1; x += -1", async () => {
    const ret = await run(`
      export function test(): number {
        var x: any;
        x = -1;
        x += -1;
        return x;
      }
    `);
    expect(ret).toBe(-2);
  });

  it("externref postfix increment", async () => {
    const ret = await run(`
      export function test(): number {
        var x: any;
        x = 5;
        x++;
        return x;
      }
    `);
    expect(ret).toBe(6);
  });

  it("for loop with externref counter and comparison", async () => {
    const ret = await run(`
      export function test(): number {
        var supreme: any = 5;
        var count: any;
        for(count=0;;) {
          if (count===supreme) break;
          count++;
        }
        return count;
      }
    `);
    expect(ret).toBe(5);
  });

  it("externref bitwise compound assignment", async () => {
    const ret = await run(`
      export function test(): number {
        var x: any;
        x = 7;
        x &= 3;
        return x;
      }
    `);
    expect(ret).toBe(3);
  });

  it("switch with externref discriminant", async () => {
    const ret = await run(`
      export function test(): number {
        var value: any = 2;
        var result: number = 0;
        switch(value) {
          case 0: result = 10; break;
          case 1: result = 20; break;
          case 2: result = 30; break;
        }
        return result;
      }
    `);
    expect(ret).toBe(30);
  });

  it("logical not on falsy externref", async () => {
    const ret = await run(`
      export function test(): number {
        var x: any = 0;
        if (!x) return 1;
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("Math.round(-0.5) preserves -0", async () => {
    const ret = await run(`
      export function test(): number {
        return 1 / Math.round(-0.5);
      }
    `);
    expect(ret).toBe(-Infinity);
  });

  it("Math.round(0.5) = 1", async () => {
    const ret = await run(`
      export function test(): number {
        return Math.round(0.5);
      }
    `);
    expect(ret).toBe(1);
  });

  it("Math.round(-0.25) preserves -0", async () => {
    const ret = await run(`
      export function test(): number {
        return 1 / Math.round(-0.25);
      }
    `);
    expect(ret).toBe(-Infinity);
  });
});
