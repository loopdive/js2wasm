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

describe("issue-283: compound assignment on property access", () => {
  it("obj.x += 1", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 10, y: 20 };
        }
        export function test(): number {
          const obj = make();
          obj.x += 5;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(15);
  });

  it("obj.x -= 3", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 10, y: 20 };
        }
        export function test(): number {
          const obj = make();
          obj.x -= 3;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(7);
  });

  it("obj.x *= 2", async () => {
    expect(
      await run(
        `
        function make(): { x: number } {
          return { x: 5 };
        }
        export function test(): number {
          const obj = make();
          obj.x *= 2;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(10);
  });

  it("obj.x /= 2", async () => {
    expect(
      await run(
        `
        function make(): { x: number } {
          return { x: 10 };
        }
        export function test(): number {
          const obj = make();
          obj.x /= 2;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(5);
  });

  it("obj.x %= 3", async () => {
    expect(
      await run(
        `
        function make(): { x: number } {
          return { x: 10 };
        }
        export function test(): number {
          const obj = make();
          obj.x %= 3;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(1);
  });

  it("obj.x **= 2", async () => {
    expect(
      await run(
        `
        function make(): { x: number } {
          return { x: 3 };
        }
        export function test(): number {
          const obj = make();
          obj.x **= 2;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(9);
  });

  it("compound assignment returns the new value", async () => {
    expect(
      await run(
        `
        function make(): { x: number } {
          return { x: 10 };
        }
        export function test(): number {
          const obj = make();
          return obj.x += 5;
        }
        `,
        "test",
      ),
    ).toBe(15);
  });

  it("multiple compound assignments on same object", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 10, y: 20 };
        }
        export function test(): number {
          const obj = make();
          obj.x += 5;
          obj.y -= 10;
          return obj.x + obj.y;
        }
        `,
        "test",
      ),
    ).toBe(25);
  });

  it("bitwise compound assignment: obj.x &= mask", async () => {
    expect(
      await run(
        `
        function make(): { x: number } {
          return { x: 15 };
        }
        export function test(): number {
          const obj = make();
          obj.x &= 6;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(6);
  });

  it("bitwise compound assignment: obj.x |= bits", async () => {
    expect(
      await run(
        `
        function make(): { x: number } {
          return { x: 5 };
        }
        export function test(): number {
          const obj = make();
          obj.x |= 2;
          return obj.x;
        }
        `,
        "test",
      ),
    ).toBe(7);
  });
});

describe("issue-283: compound assignment on element access", () => {
  it("arr[0] += 5", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const arr: number[] = [10, 20, 30];
          arr[0] += 5;
          return arr[0];
        }
        `,
        "test",
      ),
    ).toBe(15);
  });

  it("arr[i] -= 3 with variable index", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const arr: number[] = [10, 20, 30];
          const i = 1;
          arr[i] -= 3;
          return arr[i];
        }
        `,
        "test",
      ),
    ).toBe(17);
  });

  it("obj['x'] += 5 (bracket notation on struct)", async () => {
    expect(
      await run(
        `
        function make(): { x: number; y: number } {
          return { x: 10, y: 20 };
        }
        export function test(): number {
          const obj = make();
          obj["x"] += 5;
          return obj["x"];
        }
        `,
        "test",
      ),
    ).toBe(15);
  });

  it("arr[0] *= 3", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const arr: number[] = [4, 5, 6];
          arr[0] *= 3;
          return arr[0];
        }
        `,
        "test",
      ),
    ).toBe(12);
  });

  it("element compound assignment returns new value", async () => {
    expect(
      await run(
        `
        export function test(): number {
          const arr: number[] = [10, 20, 30];
          return arr[1] += 5;
        }
        `,
        "test",
      ),
    ).toBe(25);
  });
});
