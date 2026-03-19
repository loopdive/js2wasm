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

describe("struct.get on null ref type (#567)", () => {
  it("null assigned to struct-typed local", async () => {
    expect(
      await run(
        `
        class Foo {
          value: number;
          constructor(v: number) { this.value = v; }
        }
        export function test(): number {
          let f: Foo | null = null;
          f = new Foo(42);
          return f.value;
        }
        `,
        "test",
      ),
    ).toBe(42);
  });

  it("function returning null for struct type", async () => {
    expect(
      await run(
        `
        function maybeGet(flag: boolean): { x: number } | null {
          if (flag) return { x: 99 };
          return null;
        }
        export function test(): number {
          const obj = maybeGet(true);
          if (obj !== null) return obj.x;
          return -1;
        }
        `,
        "test",
      ),
    ).toBe(99);
  });

  it("null return path does not cause validation error", async () => {
    expect(
      await run(
        `
        function maybeGet(): { x: number } | null {
          return null;
        }
        export function test(): number {
          const obj = maybeGet();
          if (obj !== null) return obj.x;
          return -1;
        }
        `,
        "test",
      ),
    ).toBe(-1);
  });

  it("null assignment and later struct access", async () => {
    expect(
      await run(
        `
        export function test(): number {
          let obj: { a: number, b: number } | null = null;
          obj = { a: 10, b: 20 };
          return obj.a + obj.b;
        }
        `,
        "test",
      ),
    ).toBe(30);
  });

  it("array typed local initialized to null", async () => {
    expect(
      await run(
        `
        export function test(): number {
          let arr: number[] | null = null;
          arr = [10, 20, 30];
          return arr[1];
        }
        `,
        "test",
      ),
    ).toBe(20);
  });
});
