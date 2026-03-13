import { describe, it, expect } from "vitest";
import { assertEquivalent, compileToWasm } from "./equivalence/helpers.js";

describe("Issue #361: Runtime `in` operator for property checks", () => {
  // --- Static key checks (string literal in object) ---

  it("'prop' in obj returns true for existing property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        return ('a' in obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("'prop' in obj returns false for non-existing property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1, b: 2 };
        return ('z' in obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple in checks on same object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10, y: 20, z: 30 };
        let count = 0;
        if ('x' in obj) count++;
        if ('y' in obj) count++;
        if ('z' in obj) count++;
        if ('w' in obj) count++;
        return count;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- Numeric index in array ---

  it("index in array returns true for valid index", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        return (0 in arr) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("index in array returns false for out-of-bounds index", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        return (5 in arr) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator in conditional expressions ---

  it("in operator used in if-else", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { name: "hello", value: 42 };
        if ('name' in obj) {
          return 1;
        } else {
          return 0;
        }
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("in operator used in ternary", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1 };
        return ('a' in obj) ? 100 : 200;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator with various object shapes ---

  it("in operator with nested object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { outer: { inner: 1 } };
        const hasOuter = ('outer' in obj) ? 1 : 0;
        return hasOuter;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("in operator checking multiple properties with accumulator", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        let result = 0;
        if ('a' in obj) result += 1;
        if ('b' in obj) result += 2;
        if ('c' in obj) result += 4;
        if ('d' in obj) result += 8;
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator as boolean expression ---

  it("in operator result stored in variable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 1 };
        const hasX = 'x' in obj;
        const hasY = 'y' in obj;
        return (hasX ? 1 : 0) + (hasY ? 2 : 0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator with logical operators ---

  it("in operator combined with && and ||", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1, b: 2 };
        if ('a' in obj && 'b' in obj) return 1;
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("in operator with || for missing props", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1 };
        if ('x' in obj || 'a' in obj) return 1;
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- Numeric string keys ---

  it("numeric string key in object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        return ('1' in arr) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator in function parameter object ---

  it("in operator on function parameter", async () => {
    await assertEquivalent(
      `
      function hasKey(obj: { a?: number; b?: number }): number {
        return ('a' in obj) ? 1 : 0;
      }
      export function test(): number {
        return hasKey({ a: 5 });
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator negation ---

  it("negated in operator", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1 };
        if (!('b' in obj)) return 1;
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator with class instances ---

  // --- Array bounds edge cases ---

  it("last valid index in array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        return (2 in arr) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("index equal to length returns false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        return (3 in arr) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("'length' in array returns true", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [1, 2, 3];
        return ('length' in arr) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // --- In operator with class instances ---

  it("in operator with class instance", async () => {
    await assertEquivalent(
      `
      class Foo {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const foo = new Foo(1, 2);
        let result = 0;
        if ('x' in foo) result += 1;
        if ('y' in foo) result += 2;
        if ('z' in foo) result += 4;
        return result;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
