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

describe("string enums", () => {
  it("string enum member returns the string value", async () => {
    const src = `
      enum Color { Red = "RED", Green = "GREEN", Blue = "BLUE" }
      export function test(): string {
        return Color.Red;
      }
    `;
    expect(await run(src, "test")).toBe("RED");
  });

  it("string enum in comparison", async () => {
    const src = `
      enum Status { Active = "ACTIVE", Inactive = "INACTIVE" }
      export function isActive(s: string): boolean {
        return s === Status.Active;
      }
    `;
    expect(await run(src, "isActive", ["ACTIVE"])).toBe(1);
    expect(await run(src, "isActive", ["INACTIVE"])).toBe(0);
  });

  it("multiple string enum members", async () => {
    const src = `
      enum Direction { Up = "UP", Down = "DOWN", Left = "LEFT", Right = "RIGHT" }
      export function getDown(): string {
        return Direction.Down;
      }
    `;
    expect(await run(src, "getDown")).toBe("DOWN");
  });

  it("string enum coexists with numeric enum", async () => {
    const src = `
      enum Color { Red = "RED", Green = "GREEN" }
      enum Num { A = 10, B = 20 }
      export function getColor(): string {
        return Color.Green;
      }
      export function getNum(): number {
        return Num.B;
      }
    `;
    expect(await run(src, "getColor")).toBe("GREEN");
    expect(await run(src, "getNum")).toBe(20);
  });

  it("string enum in string pool", () => {
    const result = compile(`
      enum Color { Red = "RED", Green = "GREEN" }
      export function test(): string {
        return Color.Red;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.stringPool).toContain("RED");
    expect(result.stringPool).toContain("GREEN");
  });
});
