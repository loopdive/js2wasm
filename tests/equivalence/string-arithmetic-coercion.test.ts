import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("string-to-number coercion for arithmetic operators (#430)", () => {
  it("string - string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "5";
        const b: string = "2";
        return (a as any) - (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string * string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "6";
        const b: string = "7";
        return (a as any) * (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string / string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "10";
        const b: string = "2";
        return (a as any) / (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string % string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "7";
        const b: string = "3";
        return (a as any) % (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string & string (bitwise AND)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "7";
        const b: string = "3";
        return (a as any) & (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string | string (bitwise OR)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "5";
        const b: string = "3";
        return (a as any) | (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string ^ string (bitwise XOR)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "5";
        const b: string = "3";
        return (a as any) ^ (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string << string (left shift)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "5";
        const b: string = "2";
        return (a as any) << (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string >> string (right shift)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "20";
        const b: string = "2";
        return (a as any) >> (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("non-numeric string produces NaN", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "hello";
        const b: string = "1";
        const result = (a as any) - (b as any);
        return isNaN(result) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string subtraction equals zero for equal values", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: string = "1";
        const b: string = "1";
        return (a as any) - (b as any);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
