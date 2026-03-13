import { describe, test, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #238: Class expression new -- new (class{})() pattern", () => {
  test("anonymous class expression with no constructor", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = new (class { x: number = 42; })();
        return obj.x;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  test("anonymous class expression with constructor", async () => {
    await assertEquivalent(
      `export function test(v: number): number {
        const obj = new (class {
          value: number;
          constructor(v: number) { this.value = v; }
        })(v);
        return obj.value;
      }`,
      [
        { fn: "test", args: [10] },
        { fn: "test", args: [99] },
      ],
    );
  });

  test("named class expression in new", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = new (class MyClass {
          value: number;
          constructor() { this.value = 7; }
        })();
        return obj.value;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  test("class expression with method", async () => {
    await assertEquivalent(
      `export function test(): number {
        const obj = new (class {
          x: number;
          constructor() { this.x = 5; }
          getX(): number { return this.x; }
        })();
        return obj.getX();
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  test("class expression with constructor args", async () => {
    await assertEquivalent(
      `export function test(a: number, b: number): number {
        const obj = new (class {
          sum: number;
          constructor(a: number, b: number) { this.sum = a + b; }
        })(a, b);
        return obj.sum;
      }`,
      [
        { fn: "test", args: [3, 4] },
        { fn: "test", args: [10, 20] },
      ],
    );
  });
});
