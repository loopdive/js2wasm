import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("typeof operator extended", () => {
  it("typeof number", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const x = 42;
        return typeof x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof string", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const s = "hello";
        return typeof s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof boolean", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const b = true;
        return typeof b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof in conditional expression", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x = 42;
        return typeof x === "number" ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof for type narrowing", async () => {
    await assertEquivalent(
      `
      function process(x: number | string): number {
        if (typeof x === "number") {
          return x * 2;
        }
        return 0;
      }
      export function test(): number {
        return process(21);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof undefined", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const x = undefined;
        return typeof x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof function", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const fn = () => 42;
        return typeof fn;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
