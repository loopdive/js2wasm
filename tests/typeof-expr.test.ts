import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, jsApi } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[]): Promise<unknown> {
  const result = compile(source);
  if (!result.success)
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  const imports = buildImports(result.stringPool, jsApi);
  const { instance } = await WebAssembly.instantiate(
    result.binary,
    imports as WebAssembly.Imports,
  );
  return (instance.exports as any)[fn](...args);
}

describe("typeof as standalone expression", () => {
  it("typeof number variable returns 'number'", async () => {
    const result = await run(
      `
      export function test(): string {
        const x: number = 42;
        return typeof x;
      }
    `,
      "test",
      [],
    );
    expect(result).toBe("number");
  });

  it("typeof boolean variable returns 'boolean'", async () => {
    const result = await run(
      `
      export function test(): string {
        const x: boolean = true;
        return typeof x;
      }
    `,
      "test",
      [],
    );
    expect(result).toBe("boolean");
  });

  it("typeof string variable returns 'string'", async () => {
    const result = await run(
      `
      export function test(): string {
        const x: string = "hello";
        return typeof x;
      }
    `,
      "test",
      [],
    );
    expect(result).toBe("string");
  });

  it("typeof number parameter returns 'number'", async () => {
    const result = await run(
      `
      export function test(x: number): string {
        return typeof x;
      }
    `,
      "test",
      [3.14],
    );
    expect(result).toBe("number");
  });

  it("typeof boolean parameter returns 'boolean'", async () => {
    const result = await run(
      `
      export function test(x: boolean): string {
        return typeof x;
      }
    `,
      "test",
      [1],
    );
    expect(result).toBe("boolean");
  });

  it("typeof union parameter dispatches at runtime", async () => {
    const src = `
      export function test(x: number | string): string {
        return typeof x;
      }
    `;
    expect(await run(src, "test", [42])).toBe("number");
    expect(await run(src, "test", ["hello"])).toBe("string");
  });

  it("typeof result can be assigned to a variable", async () => {
    const result = await run(
      `
      export function test(): string {
        const x: number = 10;
        const t: string = typeof x;
        return t;
      }
    `,
      "test",
      [],
    );
    expect(result).toBe("number");
  });

  it("typeof works inside comparison after standalone use", async () => {
    // Ensure standalone typeof doesn't break typeof-in-comparison
    const result = await run(
      `
      export function test(x: number | string): number {
        const t: string = typeof x;
        if (typeof x === "number") {
          return 1;
        }
        return 0;
      }
    `,
      "test",
      [42],
    );
    expect(result).toBe(1);
  });
});
