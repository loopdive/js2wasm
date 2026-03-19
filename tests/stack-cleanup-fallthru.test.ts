import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {
    env: {},
  });
  return (instance.exports as any).result();
}

describe("stack cleanup at fallthrough", () => {
  it("expression statement with function call returning value", async () => {
    expect(
      await run(`
        function foo(): number { return 42; }
        export function result(): number {
          foo();
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("expression statement with prefix increment", async () => {
    expect(
      await run(`
        export function result(): number {
          let x = 5;
          ++x;
          return x;
        }
      `),
    ).toBe(6);
  });

  it("expression statement with postfix increment", async () => {
    expect(
      await run(`
        export function result(): number {
          let x = 5;
          x++;
          return x;
        }
      `),
    ).toBe(6);
  });

  it("multiple expression statements in sequence", async () => {
    expect(
      await run(`
        function foo(): number { return 1; }
        export function result(): number {
          foo();
          foo();
          foo();
          return 1;
        }
      `),
    ).toBe(1);
  });

  it("while loop with postfix increment", async () => {
    expect(
      await run(`
        export function result(): number {
          let x = 0;
          while (x < 5) {
            x++;
          }
          return x;
        }
      `),
    ).toBe(5);
  });
});
