import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object.defineProperty (#346)", () => {
  it("simple value descriptor sets the property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "x", { value: 42 });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("returns the object (same reference)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "y", { value: 10 });
        return obj.y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("value descriptor with writable flag", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "z", { value: 99, writable: true });
        return obj.z;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple defineProperty calls", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = {};
        Object.defineProperty(obj, "a", { value: 1 });
        Object.defineProperty(obj, "b", { value: 2 });
        return obj.a + obj.b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("defineProperty with string value", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const obj: any = {};
        Object.defineProperty(obj, "name", { value: "hello" });
        return obj.name;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
