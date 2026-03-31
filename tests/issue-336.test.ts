import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("issue-336: for-of object destructuring on non-struct refs", () => {
  it("empty object destructuring on booleans", async () => {
    const val = await run(
      `
      export function test(): number {
        let counter = 0;
        const arr: boolean[] = [false];
        for ({} of arr) {
          counter += 1;
        }
        return counter;
      }
    `,
      "test",
    );
    expect(val).toBe(1);
  });

  it("empty object destructuring on numbers", async () => {
    const val = await run(
      `
      export function test(): number {
        let counter = 0;
        const arr: number[] = [0];
        for ({} of arr) {
          counter += 1;
        }
        return counter;
      }
    `,
      "test",
    );
    expect(val).toBe(1);
  });

  it("empty object destructuring on strings", async () => {
    const val = await run(
      `
      export function test(): number {
        let counter = 0;
        const arr: string[] = [""];
        for ({} of arr) {
          counter += 1;
        }
        return counter;
      }
    `,
      "test",
    );
    expect(val).toBe(1);
  });

  it("empty object destructuring on multiple elements", async () => {
    const val = await run(
      `
      export function test(): number {
        let counter = 0;
        const arr: number[] = [1, 2, 3];
        for ({} of arr) {
          counter += 1;
        }
        return counter;
      }
    `,
      "test",
    );
    expect(val).toBe(3);
  });

  it("empty binding pattern destructuring on numbers", async () => {
    const val = await run(
      `
      export function test(): number {
        let counter = 0;
        const arr: number[] = [42];
        for (let {} of arr) {
          counter += 1;
        }
        return counter;
      }
    `,
      "test",
    );
    expect(val).toBe(1);
  });

  it("empty binding pattern destructuring on booleans", async () => {
    const val = await run(
      `
      export function test(): number {
        let counter = 0;
        const arr: boolean[] = [true, false];
        for (let {} of arr) {
          counter += 1;
        }
        return counter;
      }
    `,
      "test",
    );
    expect(val).toBe(2);
  });
});
