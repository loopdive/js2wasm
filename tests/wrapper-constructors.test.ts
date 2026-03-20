import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #123: Wrapper constructors (new Number/String/Boolean)", () => {
  it("new Number(42) typeof returns object", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const n = new Number(42);
        return typeof n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Number(42) valueOf via unary +", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const n = new Number(42);
        return +n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new String('hello') typeof returns object", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const s = new String("hello");
        return typeof s;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Boolean(true) typeof returns object", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const b = new Boolean(true);
        return typeof b;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Number() defaults to 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const n = new Number();
        return +n;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("compiles new Number without errors", () => {
    const result = compile(`
      export function test(): number {
        const n = new Number(42);
        return +n;
      }
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("compiles new String without errors", () => {
    const result = compile(`
      export function test(): string {
        const s = new String("hello");
        return "" + s;
      }
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("compiles new Boolean without errors", () => {
    const result = compile(`
      export function test(): boolean {
        const b = new Boolean(false);
        return !!b;
      }
    `);
    expect(result.errors).toHaveLength(0);
  });
});
