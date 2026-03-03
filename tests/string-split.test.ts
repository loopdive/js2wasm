import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, jsApi } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map(e => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`);
  }
  const imports = buildImports(result.stringPool, jsApi);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("string.split()", () => {
  it("basic split by comma", async () => {
    const src = `
      export function first(): string {
        const parts = "a,b,c".split(",");
        return parts[0];
      }
    `;
    expect(await run(src, "first")).toBe("a");
  });

  it("access second element", async () => {
    const src = `
      export function second(): string {
        const parts = "a,b,c".split(",");
        return parts[1];
      }
    `;
    expect(await run(src, "second")).toBe("b");
  });

  it("split by empty string", async () => {
    const src = `
      export function firstChar(): string {
        const chars = "hi".split("");
        return chars[0];
      }
    `;
    expect(await run(src, "firstChar")).toBe("h");
  });

  it("split result length", async () => {
    const src = `
      export function count(): number {
        const parts = "a,b,c".split(",");
        return parts.length;
      }
    `;
    expect(await run(src, "count")).toBe(3);
  });

  it("split with variable separator", async () => {
    const src = `
      export function test(s: string, sep: string): string {
        const parts = s.split(sep);
        return parts[0];
      }
    `;
    expect(await run(src, "test", ["hello-world", "-"])).toBe("hello");
  });
});
