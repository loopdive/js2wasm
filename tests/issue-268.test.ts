import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runFast(source: string, exportName = "test"): Promise<any> {
  const result = compile(source, { fast: true });
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
  return (instance.exports[exportName] as Function)();
}

describe("Issue #268: for-of on strings", () => {
  it("counts characters in a string literal", async () => {
    expect(
      await runFast(`
      export function test(): number {
        let count = 0;
        for (const c of "hello") {
          count++;
        }
        return count;
      }
    `),
    ).toBe(5);
  });

  it("counts characters in a variable string", async () => {
    expect(
      await runFast(`
      export function test(): number {
        const s = "abcdef";
        let count = 0;
        for (const c of s) {
          count++;
        }
        return count;
      }
    `),
    ).toBe(6);
  });

  it("iterates over empty string", async () => {
    expect(
      await runFast(`
      export function test(): number {
        let count = 0;
        for (const c of "") {
          count++;
        }
        return count;
      }
    `),
    ).toBe(0);
  });

  it("break works inside for-of on string", async () => {
    expect(
      await runFast(`
      export function test(): number {
        let count = 0;
        for (const c of "hello world") {
          count++;
          if (count === 3) break;
        }
        return count;
      }
    `),
    ).toBe(3);
  });
});
