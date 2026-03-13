import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string = "test", args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("issue-368: global/arrow this reference", () => {
  it("this in module scope is undefined", async () => {
    // In strict mode (module code), `this` is undefined
    expect(await run(`
      export function test(): number {
        const x: any = this;
        if (x === undefined) return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("this in arrow function inside method captures method this", async () => {
    expect(await run(`
      class Obj {
        x: number;
        constructor() { this.x = 42; }
        getX(): number {
          const arrow = (): number => this.x;
          return arrow();
        }
      }
      export function test(): number {
        return new Obj().getX();
      }
    `)).toBe(42);
  });

  it("this in arrow function inside method - mutation", async () => {
    expect(await run(`
      class Counter {
        val: number;
        constructor() { this.val = 0; }
        increment(): number {
          const inc = (): void => { this.val = this.val + 1; };
          inc();
          inc();
          return this.val;
        }
      }
      export function test(): number {
        return new Counter().increment();
      }
    `)).toBe(2);
  });

  it("this in nested arrow functions captures from method", async () => {
    expect(await run(`
      class Obj {
        x: number;
        constructor() { this.x = 10; }
        getX(): number {
          const outer = (): number => {
            const inner = (): number => this.x;
            return inner();
          };
          return outer();
        }
      }
      export function test(): number {
        return new Obj().getX();
      }
    `)).toBe(10);
  });

  it("this in top-level function is undefined", async () => {
    // In strict mode, `this` in a regular function call is undefined
    expect(await run(`
      export function test(): number {
        const x: any = this;
        if (x === undefined) return 1;
        return 0;
      }
    `)).toBe(1);
  });
});
