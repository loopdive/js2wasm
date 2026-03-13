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

describe("issue-230: computed property names with variable keys", () => {
  it("let variable string key", async () => {
    expect(
      await run(
        `
      let key = "x";
      function make(): { x: number } {
        return { [key]: 42 };
      }
      export function test(): number {
        return make().x;
      }
    `,
        "test",
      ),
    ).toBe(42);
  });

  it("let variable numeric key", async () => {
    expect(
      await run(
        `
      let k = 1;
      function make(): { 1: number } {
        return { [k]: 99 };
      }
      export function test(): number {
        const obj = make();
        return obj[1];
      }
    `,
        "test",
      ),
    ).toBe(99);
  });

  it("var variable string key", async () => {
    expect(
      await run(
        `
      var key = "name";
      function make(): { name: number } {
        return { [key]: 55 };
      }
      export function test(): number {
        return make().name;
      }
    `,
        "test",
      ),
    ).toBe(55);
  });

  it("multiple let variable keys", async () => {
    expect(
      await run(
        `
      let k1 = "a";
      let k2 = "b";
      function make(): { a: number; b: number } {
        return { [k1]: 10, [k2]: 20 };
      }
      export function test(): number {
        const obj = make();
        return obj.a + obj.b;
      }
    `,
        "test",
      ),
    ).toBe(30);
  });
});
