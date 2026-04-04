import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm, assertEquivalent } from "./equivalence/helpers.js";

/** Helper: compile source, return errors array (empty if success) */
function compileErrors(source: string): string[] {
  const r = compile(source);
  return r.success ? [] : r.errors.map((e) => e.message);
}

describe("Issue #266: Scope resolution for multi-variable patterns", () => {
  describe("Array destructuring compiles without unknown identifier errors", () => {
    it("basic array destructuring: const [a, b, c] = [1, 2, 3]", () => {
      const errors = compileErrors(`
        export function test(): number {
          const arr: number[] = [1, 2, 3];
          const [a, b, c] = arr;
          return a + b + c;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("rest element in array destructuring: const [a, ...rest] = arr", () => {
      const errors = compileErrors(`
        export function test(): number {
          const arr: number[] = [1, 2, 3, 4];
          const [a, ...rest] = arr;
          return a;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("nested array destructuring: const [[a, b], [c, d]] = nested", () => {
      const errors = compileErrors(`
        export function test(): number {
          const nested: number[][] = [[1, 2], [3, 4]];
          const [[a, b], [c, d]] = nested;
          return a + b + c + d;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("Object destructuring compiles without unknown identifier errors", () => {
    it("basic object destructuring: const {x, y} = obj", () => {
      const errors = compileErrors(`
        export function test(): number {
          const obj = {x: 1, y: 2};
          const {x, y} = obj;
          return x + y;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("nested object destructuring: const {a, b: {c}} = obj", () => {
      const errors = compileErrors(`
        export function test(): number {
          const obj = {a: 1, b: {c: 2}};
          const {a, b: {c}} = obj;
          return a + c;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("object destructuring with renaming: const {x: a, y: b} = obj", () => {
      const errors = compileErrors(`
        export function test(): number {
          const obj = {x: 10, y: 20};
          const {x: a, y: b} = obj;
          return a + b;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("Multi-variable let/const declarations", () => {
    it("let x = 1, y = 2, z = 3", () => {
      const errors = compileErrors(`
        export function test(): number {
          let x = 1, y = 2, z = 3;
          return x + y + z;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("const a = 1, b = 2", () => {
      const errors = compileErrors(`
        export function test(): number {
          const a = 1, b = 2;
          return a + b;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("For statement with destructuring initializer", () => {
    it("for (const [x, y, z] = [1, 2, 3]; ...)", () => {
      const errors = compileErrors(`
        export function test(): number {
          const arr: number[] = [1, 2, 3];
          let sum = 0;
          for (const [x, y, z] = arr; sum < 1; ) {
            sum = x + y + z;
          }
          return sum;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("for (const {a, b} = obj; ...)", () => {
      const errors = compileErrors(`
        export function test(): number {
          const obj = {a: 10, b: 20};
          let sum = 0;
          for (const {a, b} = obj; sum < 1; ) {
            sum = a + b;
          }
          return sum;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("for (let [a, b] = arr; ...) compiles without unknown identifiers", () => {
      const errors = compileErrors(`
        export function test(): number {
          const arr: number[] = [3, 5];
          let r = 0;
          for (let [a, b] = arr; r < 1; ) {
            r = 1;
          }
          return r;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("For loop destructuring", () => {
    it("for...in loop variable is in scope (compile only)", () => {
      const r = compile(`
        export function test(): number {
          const obj = {a: 1, b: 2};
          let count = 0;
          for (const key in obj) {
            count += 1;
          }
          return count;
        }
      `);
      const unknowns = (r.success ? [] : r.errors.map((e) => e.message)).filter((e) =>
        e.includes("Unknown identifier"),
      );
      expect(unknowns).toEqual([]);
    });
  });

  describe("Var hoisting with destructuring", () => {
    it("var [a, b] = arr should be hoisted", () => {
      const errors = compileErrors(`
        export function test(): number {
          var arr: number[] = [1, 2];
          var [a, b] = arr;
          return a + b;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("var {x, y} = obj should be hoisted", () => {
      const errors = compileErrors(`
        export function test(): number {
          var obj = {x: 10, y: 20};
          var {x, y} = obj;
          return x + y;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("Destructuring in for-of loops", () => {
    it("for (const [a, b] of arr) -- array destructuring in for-of", () => {
      const errors = compileErrors(`
        export function test(): number {
          const arr: number[][] = [[1, 2], [3, 4]];
          let sum = 0;
          for (const [a, b] of arr) {
            sum += a + b;
          }
          return sum;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("Multiple destructuring in same scope", () => {
    it("two destructuring declarations in same function", () => {
      const errors = compileErrors(`
        export function test(): number {
          const obj1 = {a: 1, b: 2};
          const obj2 = {c: 3, d: 4};
          const {a, b} = obj1;
          const {c, d} = obj2;
          return a + b + c + d;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("Destructuring with default values", () => {
    it("const {x = 10, y = 20} = obj", () => {
      const errors = compileErrors(`
        export function test(): number {
          const obj: {x?: number, y?: number} = {};
          const {x = 10, y = 20} = obj;
          return (x ?? 0) + (y ?? 0);
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("Function parameter destructuring", () => {
    it("function with array destructured parameter", () => {
      const errors = compileErrors(`
        export function test([x, y, z]: number[]): number {
          return x + y + z;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });

    it("function with object destructured parameter", () => {
      const errors = compileErrors(`
        export function test({a, b}: {a: number, b: number}): number {
          return a + b;
        }
      `);
      const unknowns = errors.filter((e) => e.includes("Unknown identifier"));
      expect(unknowns).toEqual([]);
    });
  });

  describe("Equivalence tests", () => {
    it("array destructuring produces correct values", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const arr: number[] = [10, 20, 30];
          const [a, b, c] = arr;
          return a + b + c;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("for statement with array destructuring initializer works correctly", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const arr: number[] = [1, 2, 3];
          let sum = 0;
          for (const [x, y, z] = arr; sum === 0; ) {
            sum = x + y + z;
          }
          return sum;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("object destructuring produces correct values", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = {x: 5, y: 15};
          const {x, y} = obj;
          return x + y;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });

    it("nested object destructuring produces correct values", async () => {
      await assertEquivalent(
        `
        export function test(): number {
          const obj = {a: 5, b: {c: 15}};
          const {a, b: {c}} = obj;
          return a + c;
        }
        `,
        [{ fn: "test", args: [] }],
      );
    });
  });
});
