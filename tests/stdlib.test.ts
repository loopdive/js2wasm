import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("stdlib: Math methods", () => {
  it("Math.trunc", async () => {
    const e = await compileAndRun(`
      export function test(x: number): number { return Math.trunc(x); }
    `);
    expect(e.test(4.7)).toBe(4);
    expect(e.test(-4.7)).toBe(-4);
    expect(e.test(0.1)).toBe(0);
  });

  it("Math.sign", async () => {
    const e = await compileAndRun(`
      export function test(x: number): number { return Math.sign(x); }
    `);
    expect(e.test(5)).toBe(1);
    expect(e.test(-5)).toBe(-1);
    expect(e.test(0)).toBe(0);
  });

  it("Math.clz32", async () => {
    const e = await compileAndRun(`
      export function test(x: number): number { return Math.clz32(x); }
    `);
    expect(e.test(1)).toBe(31);
    expect(e.test(1000)).toBe(22);
    expect(e.test(0)).toBe(32);
  });

  it("Math.imul", async () => {
    const e = await compileAndRun(`
      export function test(a: number, b: number): number { return Math.imul(a, b); }
    `);
    expect(e.test(3, 4)).toBe(12);
    expect(e.test(-5, 12)).toBe(-60);
    expect(e.test(0, 100)).toBe(0);
  });

  it("Math.min (2 args)", async () => {
    const e = await compileAndRun(`
      export function test(a: number, b: number): number { return Math.min(a, b); }
    `);
    expect(e.test(3, 7)).toBe(3);
    expect(e.test(-1, 1)).toBe(-1);
  });

  it("Math.max (2 args)", async () => {
    const e = await compileAndRun(`
      export function test(a: number, b: number): number { return Math.max(a, b); }
    `);
    expect(e.test(3, 7)).toBe(7);
    expect(e.test(-1, 1)).toBe(1);
  });
});

describe("stdlib: Number methods", () => {
  it("Number.isNaN", async () => {
    const e = await compileAndRun(`
      export function testNaN(): boolean { return Number.isNaN(NaN); }
      export function testNum(): boolean { return Number.isNaN(42); }
      export function testZero(): boolean { return Number.isNaN(0); }
    `);
    expect(e.testNaN()).toBe(1);
    expect(e.testNum()).toBe(0);
    expect(e.testZero()).toBe(0);
  });

  it("Number.isInteger", async () => {
    const e = await compileAndRun(`
      export function testInt(): boolean { return Number.isInteger(5); }
      export function testFloat(): boolean { return Number.isInteger(5.5); }
      export function testZero(): boolean { return Number.isInteger(0); }
    `);
    expect(e.testInt()).toBe(1);
    expect(e.testFloat()).toBe(0);
    expect(e.testZero()).toBe(1);
  });

  it("Number.isFinite", async () => {
    const e = await compileAndRun(`
      export function testNum(): boolean { return Number.isFinite(42); }
      export function testInf(): boolean { return Number.isFinite(Infinity); }
      export function testNaN(): boolean { return Number.isFinite(NaN); }
    `);
    expect(e.testNum()).toBe(1);
    expect(e.testInf()).toBe(0);
    expect(e.testNaN()).toBe(0);
  });
});

describe("stdlib: global functions", () => {
  it("isNaN", async () => {
    const e = await compileAndRun(`
      export function testNaN(): boolean { return isNaN(NaN); }
      export function testNum(): boolean { return isNaN(42); }
    `);
    expect(e.testNaN()).toBe(1);
    expect(e.testNum()).toBe(0);
  });

  it("isFinite", async () => {
    const e = await compileAndRun(`
      export function testNum(): boolean { return isFinite(42); }
      export function testInf(): boolean { return isFinite(Infinity); }
    `);
    expect(e.testNum()).toBe(1);
    expect(e.testInf()).toBe(0);
  });

  it("parseInt", async () => {
    const e = await compileAndRun(`
      export function test(s: string): number { return parseInt(s); }
    `);
    expect(e.test("42")).toBe(42);
    expect(e.test("123")).toBe(123);
  });

  it("parseFloat", async () => {
    const e = await compileAndRun(`
      export function test(s: string): number { return parseFloat(s); }
    `);
    expect(e.test("3.14")).toBeCloseTo(3.14);
    expect(e.test("42")).toBe(42);
  });
});

describe("stdlib: Array.isArray", () => {
  it("returns true for array types", async () => {
    const e = await compileAndRun(`
      export function test(): boolean {
        const arr: number[] = [1, 2, 3];
        return Array.isArray(arr);
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("returns false for non-array types", async () => {
    const e = await compileAndRun(`
      export function test(): boolean {
        const x: number = 42;
        return Array.isArray(x);
      }
    `);
    expect(e.test()).toBe(0);
  });
});

describe("stdlib: String.fromCharCode", () => {
  it("creates a string from a char code", async () => {
    const e = await compileAndRun(`
      export function test(): string {
        return String.fromCharCode(65);
      }
    `);
    expect(e.test()).toBe("A");
  });
});

describe("stdlib: String.at", () => {
  it("positive index", async () => {
    const e = await compileAndRun(`
      export function test(): string {
        const s: string = "hello";
        return s.at(1);
      }
    `);
    expect(e.test()).toBe("e");
  });

  it("negative index", async () => {
    const e = await compileAndRun(`
      export function test(): string {
        const s: string = "hello";
        return s.at(-1);
      }
    `);
    expect(e.test()).toBe("o");
  });
});

describe("stdlib: Array.at", () => {
  it("positive index", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.at(1);
      }
    `);
    expect(e.test()).toBe(20);
  });

  it("negative index", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.at(-1);
      }
    `);
    expect(e.test()).toBe(30);
  });

  it("negative index -2", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        return arr.at(-2);
      }
    `);
    expect(e.test()).toBe(20);
  });
});

describe("stdlib: Array.from", () => {
  it("creates a copy of an array", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const arr: number[] = [1, 2, 3];
        const copy: number[] = Array.from(arr);
        arr[0] = 99;
        return copy[0];
      }
    `);
    // copy should still have original value 1
    expect(e.test()).toBe(1);
  });

  it("preserves array length", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        const arr: number[] = [10, 20, 30, 40];
        const copy: number[] = Array.from(arr);
        return copy.length;
      }
    `);
    expect(e.test()).toBe(4);
  });
});

describe("stdlib: console.warn and console.error", () => {
  it("console.warn compiles and runs", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        console.warn(42);
        return 1;
      }
    `);
    expect(e.test()).toBe(1);
  });

  it("console.error compiles and runs", async () => {
    const e = await compileAndRun(`
      export function test(): number {
        console.error(99);
        return 1;
      }
    `);
    expect(e.test()).toBe(1);
  });
});
