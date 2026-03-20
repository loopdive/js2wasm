import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("in operator edge cases", () => {
  it("known property is 'in' the object", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { x: 1, y: 2 };
        if (!("x" in obj)) return 0;
        if (!("y" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("valueOf is 'in' any object (prototype property)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj: Record<string, any> = {};
        if (!("valueOf" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("toString is 'in' any object (prototype property)", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const obj = { a: 1 };
        if (!("toString" in obj)) return 0;
        return 1;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("missing property returns false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1, b: 2 };
        return ('c' in obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric index in array within bounds", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr = [10, 20, 30];
        let r = 0;
        if (0 in arr) r += 1;
        if (1 in arr) r += 2;
        if (2 in arr) r += 4;
        if (3 in arr) r += 8;
        return r;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("in operator result used as boolean", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 1, y: 2 };
        const hasX = 'x' in obj;
        const hasZ = 'z' in obj;
        return (hasX ? 10 : 0) + (hasZ ? 1 : 0);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("in operator with class instance", async () => {
    await assertEquivalent(
      `
      class Point {
        x: number;
        y: number;
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
        }
      }
      export function test(): number {
        const p = new Point(3, 4);
        let r = 0;
        if ('x' in p) r += 1;
        if ('y' in p) r += 2;
        if ('z' in p) r += 4;
        return r;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("in operator combined with logical operators", async () => {
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

  it("in operator with negation", async () => {
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
});

