import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports as any)[fn](...args);
}

describe("issue-538: PrivateIdentifier in operator and new.target", () => {
  it("typeof new.target inside constructor is function (not undefined)", { timeout: 15000 }, async () => {
    const result = await run(
      `
      class MyClass {
        flag: number;
        constructor() {
          this.flag = typeof new.target !== "undefined" ? 1 : 0;
        }
      }
      export function check(): number {
        const obj = new MyClass();
        return obj.flag;
      }
      `,
      "check",
    );
    expect(result).toBe(1);
  });

  it("new.target inside constructor is truthy", { timeout: 15000 }, async () => {
    const result = await run(
      `
      class MyClass {
        flag: number;
        constructor() {
          this.flag = new.target ? 1 : 0;
        }
      }
      export function check(): number {
        const obj = new MyClass();
        return obj.flag;
      }
      `,
      "check",
    );
    expect(result).toBe(1);
  });

  it("typeof new.target equals function string in constructor", { timeout: 15000 }, async () => {
    const result = await run(
      `
      class MyClass {
        flag: number;
        constructor() {
          this.flag = typeof new.target === "function" ? 1 : 0;
        }
      }
      export function check(): number {
        const obj = new MyClass();
        return obj.flag;
      }
      `,
      "check",
    );
    expect(result).toBe(1);
  });
});
