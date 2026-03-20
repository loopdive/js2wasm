import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("sparse array literals", () => {
  it("basic array creation and access", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = [1, 2, 3];
        return arr[0] + arr[1] + arr[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array spread at start", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [1, 2];
        const b: number[] = [...a, 3, 4];
        return b[0] + b[1] + b[2] + b[3];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array spread at end", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [3, 4];
        const b: number[] = [1, 2, ...a];
        return b[0] + b[1] + b[2] + b[3];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array spread in middle", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [2, 3];
        const b: number[] = [1, ...a, 4];
        return b[0] + b[1] + b[2] + b[3];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple spreads", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [1, 2];
        const c: number[] = [5, 6];
        const d: number[] = [...a, 3, 4, ...c];
        return d[0] + d[1] + d[2] + d[3] + d[4] + d[5];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("spread empty array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [];
        const b: number[] = [1, ...a, 2];
        return b[0] + b[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("spread only (copy array)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [10, 20, 30];
        const b: number[] = [...a];
        return b[0] + b[1] + b[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array length after spread", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [1, 2];
        const b: number[] = [0, ...a, 3];
        return b.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("spread with string arrays", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const a: string[] = ["hello"];
        const b: string[] = [...a, "world"];
        return b[0] + " " + b[1];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("nested array spread", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [1, 2];
        const b: number[] = [3, 4];
        const c: number[] = [...a, ...b];
        return c[0] + c[1] + c[2] + c[3];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("spread preserves order", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [1, 2, 3];
        const b: number[] = [0, ...a, 4];
        return b[0] * 10000 + b[1] * 1000 + b[2] * 100 + b[3] * 10 + b[4];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Array.isArray returns boolean", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = [1, 2, 3];
        if (Array.isArray(arr)) {
          return 1;
        }
        return 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array concat via spread", async () => {
    await assertEquivalent(
      `
      function concat(a: number[], b: number[]): number[] {
        return [...a, ...b];
      }
      export function test(): number {
        const result = concat([1, 2], [3, 4]);
        return result[0] + result[1] + result[2] + result[3];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("spread with computed element after", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const a: number[] = [1, 2];
        const x = 10;
        const b: number[] = [...a, x + 5];
        return b[0] + b[1] + b[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});

describe("Array constructor function calls", () => {
  it("Array(a,b,c) creates array with elements", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = Array(1, 2, 3);
        return arr[0] + arr[1] + arr[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Array(n) creates sparse array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = Array(5);
        return arr.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Array(a,b,c) creates array with elements", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = new Array(1, 2, 3);
        return arr[0] + arr[1] + arr[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("new Array(n) creates sparse array with length", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = new Array(3);
        return arr.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("Array() creates empty array", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const arr: number[] = Array();
        return arr.length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
