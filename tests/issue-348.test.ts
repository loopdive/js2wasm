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

describe("issue-348: null/undefined arithmetic coercion", () => {
  describe("unary plus", () => {
    it("+null === 0", async () => {
      const val = await run(
        `
        export function test(): number { return +null; }
      `,
        "test",
      );
      expect(val).toBe(0);
    });

    it("+undefined is NaN", async () => {
      const val = await run(
        `
        export function test(): number { return +undefined; }
      `,
        "test",
      );
      expect(val).toBeNaN();
    });
  });

  describe("unary minus", () => {
    it("-null === -0", async () => {
      const val = await run(
        `
        export function test(): number { return -null; }
      `,
        "test",
      );
      expect(Object.is(val, -0)).toBe(true);
    });

    it("-undefined is NaN", async () => {
      const val = await run(
        `
        export function test(): number { return -undefined; }
      `,
        "test",
      );
      expect(val).toBeNaN();
    });
  });

  describe("binary arithmetic with null", () => {
    it("null + 1 === 1", async () => {
      const val = await run(
        `
        export function test(): number { return (null as any) + 1; }
      `,
        "test",
      );
      expect(val).toBe(1);
    });

    it("1 + null === 1", async () => {
      const val = await run(
        `
        export function test(): number { return 1 + (null as any); }
      `,
        "test",
      );
      expect(val).toBe(1);
    });

    it("null * 5 === 0", async () => {
      const val = await run(
        `
        export function test(): number { return (null as any) * 5; }
      `,
        "test",
      );
      expect(val).toBe(0);
    });

    it("null - 3 === -3", async () => {
      const val = await run(
        `
        export function test(): number { return (null as any) - 3; }
      `,
        "test",
      );
      expect(val).toBe(-3);
    });
  });

  describe("binary arithmetic with undefined", () => {
    it("undefined + 1 is NaN", async () => {
      const val = await run(
        `
        export function test(): number { return (undefined as any) + 1; }
      `,
        "test",
      );
      expect(val).toBeNaN();
    });

    it("1 + undefined is NaN", async () => {
      const val = await run(
        `
        export function test(): number { return 1 + (undefined as any); }
      `,
        "test",
      );
      expect(val).toBeNaN();
    });

    it("undefined * 5 is NaN", async () => {
      const val = await run(
        `
        export function test(): number { return (undefined as any) * 5; }
      `,
        "test",
      );
      expect(val).toBeNaN();
    });
  });

  describe("null/undefined in comparison context", () => {
    it("null > -1 is true (0 > -1)", async () => {
      const val = await run(
        `
        export function test(): boolean { return (null as any) > -1; }
      `,
        "test",
      );
      expect(val).toBe(1);
    });

    it("null < 1 is true (0 < 1)", async () => {
      const val = await run(
        `
        export function test(): boolean { return (null as any) < 1; }
      `,
        "test",
      );
      expect(val).toBe(1);
    });
  });

  describe("bitwise operations with null/undefined", () => {
    it("null | 0 === 0", async () => {
      const val = await run(
        `
        export function test(): number { return (null as any) | 0; }
      `,
        "test",
      );
      expect(val).toBe(0);
    });

    it("null & 1 === 0", async () => {
      const val = await run(
        `
        export function test(): number { return (null as any) & 1; }
      `,
        "test",
      );
      expect(val).toBe(0);
    });
  });
});
