import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

function countUnsupported(source: string): number {
  const result = compile(source);
  return result.errors.filter((e) => e.message === "Unsupported call expression").length;
}

describe("callable property calls on class instances", () => {
  it("this.callback() where callback is function-typed property", async () => {
    expect(
      await run(
        `
      class Handler {
        callback: () => number;
        constructor(cb: () => number) { this.callback = cb; }
        run(): number { return this.callback(); }
      }
      export function test(): number {
        const h = new Handler(() => 99);
        return h.run();
      }
    `,
        "test",
      ),
    ).toBe(99);
  }, 15000);

  it("obj.fn(x) where fn is a function property with args", async () => {
    expect(
      await run(
        `
      class Obj {
        fn: (x: number) => number;
        constructor() { this.fn = (x: number) => x + 1; }
      }
      export function test(): number {
        const o = new Obj();
        return o.fn(5);
      }
    `,
        "test",
      ),
    ).toBe(6);
  }, 15000);

  it("callable property with multiple args", async () => {
    expect(
      await run(
        `
      class MathOp {
        op: (a: number, b: number) => number;
        constructor(op: (a: number, b: number) => number) { this.op = op; }
        run(a: number, b: number): number { return this.op(a, b); }
      }
      export function test(): number {
        const m = new MathOp((a: number, b: number) => a * b);
        return m.run(6, 7);
      }
    `,
        "test",
      ),
    ).toBe(42);
  }, 15000);

  it("callable property on object literal", () => {
    expect(
      countUnsupported(`
      function makeObj() {
        return { fn: (x: number) => x * 2 };
      }
      export function test(): number {
        const obj = makeObj();
        return obj.fn(21);
      }
    `),
    ).toBe(0);
  }, 15000);

  it("no unsupported errors for callable property patterns", () => {
    expect(
      countUnsupported(`
      class Handler {
        callback: () => number;
        constructor(cb: () => number) { this.callback = cb; }
        run(): number { return this.callback(); }
      }
      export function test(): number {
        const h = new Handler(() => 99);
        return h.run();
      }
    `),
    ).toBe(0);
  }, 15000);
});
