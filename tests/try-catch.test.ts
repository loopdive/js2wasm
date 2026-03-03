import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[]): Promise<unknown> {
  const result = compile(source);
  if (!result.success) throw new Error(result.errors.map(e => `L${e.line}: ${e.message}`).join("\n"));
  const imports = buildImports(result.imports);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports as any)[fn](...args);
}

describe("throw statement", () => {
  it("throw string caught by catch", async () => {
    const src = `
      export function test(): number {
        try {
          throw "error";
        } catch (e) {
          return 42;
        }
        return 0;
      }
    `;
    expect(await run(src, "test", [])).toBe(42);
  });
});

describe("try/catch", () => {
  it("basic: no exception returns try result", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        try {
          result = 10;
        } catch (e) {
          result = -1;
        }
        return result;
      }
    `;
    expect(await run(src, "test", [])).toBe(10);
  });

  it("basic: exception triggers catch", async () => {
    const src = `
      export function safeDivide(a: number, b: number): number {
        try {
          if (b === 0) throw "division by zero";
          return a / b;
        } catch (e) {
          return -1;
        }
      }
    `;
    expect(await run(src, "safeDivide", [10, 2])).toBe(5);
    expect(await run(src, "safeDivide", [10, 0])).toBe(-1);
  });

  it("nested try/catch", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        try {
          try {
            throw "inner";
          } catch (e) {
            result = 1;
          }
          result = result + 10;
        } catch (e) {
          result = -1;
        }
        return result;
      }
    `;
    expect(await run(src, "test", [])).toBe(11);
  });

  it("nested try/catch - inner exception propagates to outer", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        try {
          try {
            throw "inner";
          } catch (e) {
            throw "rethrown";
          }
        } catch (e) {
          result = 99;
        }
        return result;
      }
    `;
    expect(await run(src, "test", [])).toBe(99);
  });
});

describe("try/catch/finally", () => {
  it("finally runs on normal path", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        try {
          result = 10;
        } catch (e) {
          result = -1;
        } finally {
          result = result + 1;
        }
        return result;
      }
    `;
    expect(await run(src, "test", [])).toBe(11);
  });

  it("finally runs on exception path", async () => {
    const src = `
      export function test(): number {
        let result: number = 0;
        try {
          throw "error";
        } catch (e) {
          result = 20;
        } finally {
          result = result + 5;
        }
        return result;
      }
    `;
    expect(await run(src, "test", [])).toBe(25);
  });
});

describe("re-throw", () => {
  it("throw in catch propagates to outer", async () => {
    const src = `
      export function test(): number {
        try {
          try {
            throw "first";
          } catch (e) {
            throw "second";
          }
        } catch (e) {
          return 77;
        }
        return 0;
      }
    `;
    expect(await run(src, "test", [])).toBe(77);
  });
});
