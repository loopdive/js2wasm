import { describe, test, expect } from "vitest";
import { compileToWasm, assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #305: Computed property names and types/reference", () => {
  // -- types/reference: Object references --

  test("two variables referencing same object see property changes", async () => {
    // Based on test262 S8.7_A1: Multiple Variables Referring to a Single Object
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { oneProperty: 0 };
        const objRef = obj;
        objRef.oneProperty = -1;
        obj.oneProperty = 42;
        return objRef.oneProperty;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  test("reassigning one variable does not affect the other", async () => {
    // Based on test262 S8.7_A3: Changing reference while maintaining integrity
    await assertEquivalent(
      `
      export function test(): number {
        let a = { x: 1 };
        const b = a;
        a = { x: 2 };
        // b should still have x=1
        return b.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  test("passing object by reference to function mutates original", async () => {
    // Based on test262 S8.7_A7: Passing arguments by reference
    await assertEquivalent(
      `
      function populateAge(person: { age: number }): void {
        person.age = 50;
      }
      export function test(): number {
        const n = { age: 0 };
        const m = n;
        populateAge(m);
        return n.age;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // -- new Object() widening --

  test("new Object() with widened property assignment and shared reference", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var obj = {};
        var objRef = obj;
        objRef.oneProperty = -1;
        obj.oneProperty = 42;
        return objRef.oneProperty;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  test("new Object() with property widening", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj: any = {};
        obj.x = 42;
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // -- computed property names --

  test("computed property name with string variable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const key = "x";
        const obj = { [key]: 42 };
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  test("computed property name with numeric expression", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const idx = 1 + 1;
        const arr = [10, 20, 30];
        return arr[idx];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  test("computed property name with concatenation", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const prefix = "val";
        const key = prefix + "ue";
        const obj = { value: 99 };
        return obj[key];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  test("object bracket access with const variable key", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        const key = "b";
        return obj[key];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
