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

describe("issue-327: Object-to-primitive coercion (valueOf/toString)", () => {
  describe("prefix increment on object", () => {
    it("++{} returns NaN", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          return ++x;
        }
      `, "test");
      expect(val).toBeNaN();
    });

    it("++{} stores NaN back", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          ++x;
          return x;
        }
      `, "test");
      expect(val).toBeNaN();
    });
  });

  describe("prefix decrement on object", () => {
    it("--{} returns NaN", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          return --x;
        }
      `, "test");
      expect(val).toBeNaN();
    });

    it("--{} stores NaN back", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          --x;
          return x;
        }
      `, "test");
      expect(val).toBeNaN();
    });
  });

  describe("postfix increment on object", () => {
    it("{}++ returns NaN (old value)", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          return x++;
        }
      `, "test");
      expect(val).toBeNaN();
    });

    it("{}++ stores NaN back", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          x++;
          return x;
        }
      `, "test");
      expect(val).toBeNaN();
    });
  });

  describe("postfix decrement on object", () => {
    it("{}-- returns NaN (old value)", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          return x--;
        }
      `, "test");
      expect(val).toBeNaN();
    });

    it("{}-- stores NaN back", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          x--;
          return x;
        }
      `, "test");
      expect(val).toBeNaN();
    });
  });

  describe("arithmetic coercion on objects", () => {
    it("unary + on {} returns NaN", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          return +x;
        }
      `, "test");
      expect(val).toBeNaN();
    });

    it("unary - on {} returns NaN", async () => {
      const val = await run(`
        export function test(): number {
          var x: any = {};
          return -x;
        }
      `, "test");
      expect(val).toBeNaN();
    });
  });
});
