import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("property descriptor support (#677)", () => {
  it("Object.defineProperty with writable: false prevents assignment (sloppy)", async () => {
    // In sloppy mode, assignment to non-writable is silently ignored.
    // We test by wrapping in try/catch to handle both strict and sloppy mode.
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 42, y: 10 };
        Object.defineProperty(obj, "x", { value: 42, writable: false });
        try { obj.x = 99; } catch(e) {}
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("writable: true allows assignment", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 42 };
        Object.defineProperty(obj, "x", { value: 42, writable: true });
        obj.x = 99;
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.defineProperty with value sets the field", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 0, y: 0 };
        Object.defineProperty(obj, "x", { value: 100 });
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("writable: false on one field does not affect other fields", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 10, y: 20 };
        Object.defineProperty(obj, "x", { value: 10, writable: false });
        obj.y = 99;
        return obj.x + obj.y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.defineProperty with writable: false only (no value)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 42 };
        Object.defineProperty(obj, "x", { writable: false });
        try { obj.x = 99; } catch(e) {}
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Object.defineProperty returns the object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 0 };
        const same = Object.defineProperty(obj, "x", { value: 55, writable: false });
        return same.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple defineProperty calls on different fields", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { a: 1, b: 2, c: 3 };
        Object.defineProperty(obj, "a", { value: 10, writable: false });
        Object.defineProperty(obj, "b", { value: 20, writable: true });
        Object.defineProperty(obj, "c", { value: 30, writable: false });
        obj.b = 200;
        try { obj.a = 100; } catch(e) {}
        try { obj.c = 300; } catch(e) {}
        return obj.a + obj.b + obj.c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
