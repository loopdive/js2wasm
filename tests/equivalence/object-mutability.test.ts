import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object mutability stubs", () => {
  it("Object.freeze returns the object unchanged", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 42 };
        const frozen = Object.freeze(obj);
        return frozen.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.seal returns the object unchanged", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 10 };
        const sealed = Object.seal(obj);
        return sealed.a;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.preventExtensions returns the object unchanged", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { v: 99 };
        const result = Object.preventExtensions(obj);
        return result.v;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.isFrozen returns false (stub)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 1 };
        return Object.isFrozen(obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.isSealed returns false (stub)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 1 };
        return Object.isSealed(obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.isExtensible returns true (stub)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 1 };
        return Object.isExtensible(obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.setPrototypeOf compiles and returns object (stub)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 7 };
        const proto = { b: 3 };
        Object.setPrototypeOf(obj, proto);
        return obj.a;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.freeze chained with variable", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 5, b: 10 };
        Object.freeze(obj);
        return obj.a + obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
