import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("comparison operators with type coercion (#295)", () => {
  it("string > number coercion", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "5";
        const b: number = 3;
        return (a as any > b as any) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("number < string coercion", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number = 3;
        const b: string = "5";
        return (a as any < b as any) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("null >= 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number | null = null;
        return (a as any >= 0) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("null > 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number | null = null;
        return (a as any > 0) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("null <= 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number | null = null;
        return (a as any <= 0) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("null < 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number | null = null;
        return (a as any < 0) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("undefined > 0 is false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number | undefined = undefined;
        return (a as any > 0) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("undefined >= 0 is false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number | undefined = undefined;
        return (a as any >= 0) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("boolean > boolean comparison", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (true > false) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("boolean >= boolean comparison", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (false >= false) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("bigint vs string comparison", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let r: number = 0;
        if (1n > "0") r = r + 1;
        if ("2" > 1n) r = r + 10;
        if (0n <= "0") r = r + 100;
        if ("1" >= 1n) r = r + 1000;
        return r;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("bigint vs number comparison", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let r: number = 0;
        if (1n > 0) r = r + 1;
        if (0 < 1n) r = r + 10;
        if (1n >= 1) r = r + 100;
        if (1 <= 1n) r = r + 1000;
        return r;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
