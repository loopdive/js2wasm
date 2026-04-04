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

describe("issue 582: tuple struct type mismatch in class methods", () => {
  it("method with destructured array default", async () => {
    const result = await run(
      `
      class C {
        method([x, y, z]: [number, number, number] = [1, 2, 3]): number {
          return x + y + z;
        }
      }
      export function test(): number {
        return new C().method();
      }
    `,
      "test",
    );
    expect(result).toBe(6);
  });
});
