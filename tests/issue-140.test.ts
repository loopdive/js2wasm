import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

describe("Issue #140: Object computed property names", () => {
  it("string literal bracket access on object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 42, y: 10 };
        return obj["x"] + obj["y"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("const variable as bracket key", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const key = "x";
        const obj = { x: 99 };
        return obj[key];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed property name in object literal", async () => {
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

  it("bracket assignment on object", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { x: 0, y: 0 };
        obj["x"] = 10;
        obj["y"] = 20;
        return obj["x"] + obj["y"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric literal property name", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: { 0: number; 1: number } = { 0: 5, 1: 15 };
        return obj[0] + obj[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("getter with computed name", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {
          _val: 100,
          get ["value"](): number { return this._val; }
        };
        return obj.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("setter with string literal name", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = {
          _val: 0,
          set ["value"](v: number) { this._val = v; },
          get ["value"](): number { return this._val; }
        };
        obj.value = 55;
        return obj.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string literal computed property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { ["hello"]: 42 };
        return obj["hello"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
