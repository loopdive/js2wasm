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

describe("issue-305: computed property names and ref type fixes", () => {
  describe("computed property name edge cases", () => {
    it("numeric expression as computed property key", async () => {
      const val = await run(`
        export function test(): number {
          const idx = 1 + 1;
          const arr = [10, 20, 30];
          return arr[idx];
        }
      `, "test");
      expect(val).toBe(30);
    });

    it("const variable as computed property key", async () => {
      const val = await run(`
        export function test(): number {
          const key = "x";
          const obj = { [key]: 42 };
          return obj.x;
        }
      `, "test");
      expect(val).toBe(42);
    });

    it("object bracket access with const variable key", async () => {
      const val = await run(`
        export function test(): number {
          const obj = { a: 1, b: 2, c: 3 };
          const key = "b";
          return obj[key];
        }
      `, "test");
      expect(val).toBe(2);
    });
  });

  describe("element access on arrays of structs (ref vs ref_null)", () => {
    it("arr[0].value - property access after element access", async () => {
      const val = await run(`
        export function test(): number {
          const arr = [{ value: 42 }];
          return arr[0].value;
        }
      `, "test");
      expect(val).toBe(42);
    });

    it("arr[i].prop - dynamic index then property access", async () => {
      const val = await run(`
        export function test(): number {
          const arr = [{ x: 10 }, { x: 20 }, { x: 30 }];
          let sum = 0;
          for (let i = 0; i < 3; i++) {
            sum += arr[i].x;
          }
          return sum;
        }
      `, "test");
      expect(val).toBe(60);
    });

    it("multiple property accesses on different array elements", async () => {
      const val = await run(`
        export function test(): number {
          const items = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
          return items[0].a + items[1].b;
        }
      `, "test");
      expect(val).toBe(5);
    });

    it("nested struct access through array element stored in variable", async () => {
      const val = await run(`
        export function test(): number {
          const data = [{ x: 100 }];
          const elem = data[0];
          return elem.x;
        }
      `, "test");
      expect(val).toBe(100);
    });
  });

  describe("types/reference edge cases", () => {
    it("two variables referencing same object see property changes", async () => {
      const val = await run(`
        export function test(): number {
          const obj = { oneProperty: 0 };
          const objRef = obj;
          objRef.oneProperty = -1;
          obj.oneProperty = 42;
          return objRef.oneProperty;
        }
      `, "test");
      expect(val).toBe(42);
    });

    it("reassigning one variable does not affect the other", async () => {
      const val = await run(`
        export function test(): number {
          let a = { x: 1 };
          const b = a;
          a = { x: 2 };
          return b.x;
        }
      `, "test");
      expect(val).toBe(1);
    });

    it("passing object by reference to function mutates original", async () => {
      const val = await run(`
        function populateAge(person: { age: number }): void {
          person.age = 50;
        }
        export function test(): number {
          const n = { age: 0 };
          const m = n;
          populateAge(m);
          return n.age;
        }
      `, "test");
      expect(val).toBe(50);
    });
  });
});
