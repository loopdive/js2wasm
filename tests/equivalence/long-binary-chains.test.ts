import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("long binary expression chains", () => {
  it("long addition chain (20 terms)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a = 1;
        const b = 2;
        const c = 3;
        const d = 4;
        const e = 5;
        return a + b + c + d + e + a + b + c + d + e + a + b + c + d + e + a + b + c + d + e;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("long multiplication chain (15 terms)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a = 1;
        const b = 2;
        const c = 1;
        return a * b * c * a * b * c * a * b * c * a * b * c * a * b * c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("long subtraction chain", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 100 - 1 - 2 - 3 - 4 - 5 - 6 - 7 - 8 - 9 - 10;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("mixed arithmetic chain", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const x = 10;
        const y = 3;
        return x + y - x + y * x - y + x + y - x + y;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("long bitwise chain", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return 0xFF & 0x0F | 0x30 & 0xFF ^ 0x05 | 0x10 & 0x1F ^ 0x03;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("long comparison chain with ternary", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a = 1, b = 2, c = 3, d = 4, e = 5;
        const r1 = a + b + c + d + e;
        const r2 = e + d + c + b + a;
        return r1 === r2 ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("long string concatenation chain", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const a = "a";
        const b = "b";
        const c = "c";
        return a + b + c + a + b + c + a + b + c + a + b + c;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("50-term addition from variables", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let sum = 0;
        const v1 = 1, v2 = 2, v3 = 3, v4 = 4, v5 = 5;
        // 50 terms
        return v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5+v1+v2+v3+v4+v5;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
