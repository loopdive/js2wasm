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

describe("null pointer dereference fixes (#622)", () => {
  it("object destructuring default parameter in method", { timeout: 30000 }, async () => {
    const result = await run(
      `
      let callCount = 0;
      export function test(): number {
        class C {
          method({ x, y }: { x: number; y: number } = { x: 10, y: 20 }): void {
            callCount = x + y;
          }
        }
        new C().method();
        return callCount;
      }
      `,
      "test",
    );
    expect(result).toBe(30);
  });

  it("array destructuring default parameter in method", { timeout: 30000 }, async () => {
    const result = await run(
      `
      let callCount = 0;
      export function test(): number {
        class C {
          method([a, b, c]: number[] = [1, 2, 3]): void {
            callCount = a + b + c;
          }
        }
        new C().method();
        return callCount;
      }
      `,
      "test",
    );
    expect(result).toBe(6);
  });

  it("struct.get on non-null ref works normally", { timeout: 30000 }, async () => {
    const result = await run(
      `
      class Obj { x: number = 42; }
      export function test(): number {
        let o: Obj = new Obj();
        return o.x;
      }
      `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("default parameter ref type becomes ref_null in signature", async () => {
    const result = compile(`
      export class C {
        method({ x }: { x: number } = { x: 5 }): number {
          return x;
        }
      }
    `);
    expect(result.success).toBe(true);
    // The param should be ref null, not ref (which would trap on ref.as_non_null)
    expect(result.wat).toContain("ref null");
  });
});
