import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("new Array()", () => {
  it("new Array() creates empty array", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array();
        return a.length;
      }
    `);
    expect(e.test()).toBe(0);
  });

  it("new Array(n) creates array with length n", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array(5);
        return a.length;
      }
    `);
    expect(e.test()).toBe(5);
  });

  it("new Array(n) elements default to 0", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array(3);
        return a[0] + a[1] + a[2];
      }
    `);
    expect(e.test()).toBe(0);
  });

  it("new Array(n) with index assignment", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array(3);
        a[0] = 10;
        a[1] = 20;
        a[2] = 30;
        return a[0] + a[1] + a[2];
      }
    `);
    expect(e.test()).toBe(60);
  });

  it("new Array(a, b, c) creates array with elements", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array(10, 20, 30);
        return a[0] + a[1] + a[2];
      }
    `);
    expect(e.test()).toBe(60);
  });

  it("new Array(a, b, c) has correct length", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array(1, 2, 3, 4, 5);
        return a.length;
      }
    `);
    expect(e.test()).toBe(5);
  });

  it("new Array() with index assignment updates length (test262 pattern)", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array();
        a[0] = 100;
        a[1] = 200;
        a[2] = 300;
        if (a.length !== 3) { return 0; }
        return a[0] + a[1] + a[2];
      }
    `);
    expect(e.test()).toBe(600);
  });

  it("index assignment on regular array also updates length", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        var a: number[] = new Array(5);
        a[0] = 10;
        a[4] = 50;
        return a.length;
      }
    `);
    expect(e.test()).toBe(5);
  });
});
