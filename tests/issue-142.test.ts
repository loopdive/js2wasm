import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const defaultImports = {
  env: {
    console_log_number: () => {},
    console_log_bool: () => {},
  },
};

async function compileAndRun(source: string, imports?: Record<string, any>): Promise<any> {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);

  const { instance } = await WebAssembly.instantiate(result.binary, imports ?? defaultImports);
  return instance.exports as any;
}

describe("issue-142: destructuring assignment", () => {
  it("basic destructuring assignment into existing locals", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        let y: number = 0;
        const obj: { x: number; y: number } = { x: 10, y: 20 };
        ({ x, y } = obj);
        return x + y;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("destructuring assignment returns the RHS value", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x: number = 0;
        const obj: { x: number } = { x: 42 };
        let r: { x: number } = ({ x } = obj);
        return r.x;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("destructuring with property assignment: { prop: ident }", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let result: number = 0;
        const obj: { x: number; y: number } = { x: 7, y: 3 };
        ({ x: result } = obj);
        return result;
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("destructuring with default value in shorthand", async () => {
    const exports = await compileAndRun(`
      function makeObj(): { x: number } {
        return { x: 5 };
      }
      export function test(): number {
        let x: number = 0;
        ({ x } = makeObj());
        return x;
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("anonymous struct type resolution in destructuring", async () => {
    const exports = await compileAndRun(`
      function makePoint(a: number, b: number): { x: number; y: number } {
        return { x: a, y: b };
      }
      export function test(): number {
        let x: number = 0;
        let y: number = 0;
        ({ x, y } = makePoint(3, 4));
        return x * y;
      }
    `);
    expect(exports.test()).toBe(12);
  });

  it("nested object destructuring: { a: { b } }", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        const obj: { inner: { val: number } } = { inner: { val: 99 } };
        let val: number = 0;
        ({ inner: { val } } = obj);
        return val;
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("destructuring assignment with multiple properties", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        let c: number = 0;
        const obj: { a: number; b: number; c: number } = { a: 1, b: 2, c: 3 };
        ({ a, b, c } = obj);
        return a + b + c;
      }
    `);
    expect(exports.test()).toBe(6);
  });
});
