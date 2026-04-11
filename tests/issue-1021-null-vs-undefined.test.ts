import { describe, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";

// Issue #1021: JS spec requires destructuring defaults to apply ONLY when the
// element is `undefined`, not when it is `null`. At the Wasm layer, JS null
// maps to `ref.null.extern` (ref.is_null=1) while JS undefined is a non-null
// externref (ref.is_null=0). Defaults must therefore be gated by
// `__extern_is_undefined`, not `ref.is_null`.

describe("issue #1021 — null vs undefined in destructuring defaults", () => {
  it("array destructuring: null preserved, undefined triggers default", async () => {
    await assertEquivalent(
      `
      export function aIsNull(): number {
        const arr: any[] = [1, null, undefined];
        const [a = 10, b = 11, c = 12] = arr;
        return b === null ? 1 : 0;
      }
      export function cUsesDefault(): number {
        const arr: any[] = [1, null, undefined];
        const [a = 10, b = 11, c = 12] = arr;
        return c === 12 ? 1 : 0;
      }
      export function aKept(): number {
        const arr: any[] = [1, null, undefined];
        const [a = 10, b = 11, c = 12] = arr;
        return a === 1 ? 1 : 0;
      }
      `,
      [
        { fn: "aIsNull", args: [] },
        { fn: "cUsesDefault", args: [] },
        { fn: "aKept", args: [] },
      ],
    );
  });

  it("object destructuring: null preserved, undefined/missing triggers default", async () => {
    await assertEquivalent(
      `
      export function bIsNull(): number {
        const obj: any = { a: 1, b: null };
        const { a = 10, b = 11, c = 12 } = obj;
        return b === null ? 1 : 0;
      }
      export function cMissing(): number {
        const obj: any = { a: 1, b: null };
        const { a = 10, b = 11, c = 12 } = obj;
        return c === 12 ? 1 : 0;
      }
      `,
      [
        { fn: "bIsNull", args: [] },
        { fn: "cMissing", args: [] },
      ],
    );
  });

  it("parameter object destructuring: null preserved, undefined triggers default", async () => {
    await assertEquivalent(
      `
      function f({ a = 10, b = 11, c = 12 }: any): number {
        return (b === null ? 1 : 0) * 100 + (c === 12 ? 1 : 0) * 10 + (a === 1 ? 1 : 0);
      }
      export function test(): number {
        return f({ a: 1, b: null });
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("parameter array destructuring: null preserved, undefined triggers default", async () => {
    await assertEquivalent(
      `
      function f([a = 10, b = 11, c = 12]: any[]): number {
        return (b === null ? 1 : 0) * 100 + (c === 12 ? 1 : 0) * 10 + (a === 1 ? 1 : 0);
      }
      export function test(): number {
        return f([1, null, undefined]);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object destructuring: explicit null property does NOT trigger default", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj: any = { x: null };
        const { x = 42 } = obj;
        return x === null ? 1 : (x === 42 ? 2 : 3);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
