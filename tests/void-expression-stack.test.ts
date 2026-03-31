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

describe("void expression stack safety (#627)", () => {
  it("logical AND with void RHS does not underflow", async () => {
    expect(
      await run(
        `
        function voidFn(): void {}
        export function test(): number {
          const x = true && voidFn();
          return 1;
        }
        `,
        "test",
      ),
    ).toBe(1);
  });

  it("logical OR with void RHS does not underflow", async () => {
    expect(
      await run(
        `
        function voidFn(): void {}
        export function test(): number {
          const x = false || voidFn();
          return 1;
        }
        `,
        "test",
      ),
    ).toBe(1);
  });

  it("expression statement with logical AND void does not underflow", async () => {
    expect(
      await run(
        `
        function voidFn(): void {}
        export function test(): number {
          true && voidFn();
          return 1;
        }
        `,
        "test",
      ),
    ).toBe(1);
  });

  it("chained logical AND with void does not underflow", async () => {
    expect(
      await run(
        `
        function voidFn(): void {}
        export function test(): number {
          const x = true && true && voidFn();
          return 1;
        }
        `,
        "test",
      ),
    ).toBe(1);
  });

  it("nested logical OR then AND with void does not underflow", async () => {
    expect(
      await run(
        `
        function voidFn(): void {}
        export function test(): number {
          const x = false || (true && voidFn());
          return 1;
        }
        `,
        "test",
      ),
    ).toBe(1);
  });

  it("Array.isArray with void arg does not underflow", async () => {
    // Tests the Array.isArray compile-and-drop path
    const result = compile(`
      function voidFn(): void {}
      export function test(): number {
        const x = Array.isArray(voidFn());
        return 1;
      }
    `);
    // Should at least compile without "not enough arguments" errors
    if (!result.success) {
      const hasStackUnderflow = result.errors.some((e) => e.message.includes("not enough arguments on the stack"));
      expect(hasStackUnderflow).toBe(false);
    }
  });
});
