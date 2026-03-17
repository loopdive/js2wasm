import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("toString() and valueOf() on various types", () => {
  it("boolean.toString() returns 'true' or 'false'", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const t = true;
        const f = false;
        return t.toString() + "," + f.toString();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("boolean.valueOf() returns the boolean value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const t = true;
        const f = false;
        return (t.valueOf() ? 1 : 0) + (f.valueOf() ? 0 : 10);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("number.valueOf() returns the number itself", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const n = 42;
        return n.valueOf();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("number.toString() works on various number values", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const n = 42;
        return n.toString();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string.toString() returns the string itself", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const s = "hello";
        return s.toString();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string.valueOf() returns the string itself", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const s = "world";
        return s.valueOf();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("class instance with own toString() uses custom method", async () => {
    await assertEquivalent(
      `
      class MyClass {
        toString(): string { return "custom"; }
      }
      export function test(): string {
        const obj = new MyClass();
        return obj.toString();
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
