import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #1025: extend #1021's fix to cover the simple-parameter default guard in
// closures.ts. Previously the externref branch of emitParamDefaultCheckInline
// used `ref.is_null`, which incorrectly fired the default when the caller
// passed JS `null`. Now it uses `__extern_is_undefined` so null is preserved.

describe("#1025 — param-default externref guard uses __extern_is_undefined", () => {
  it("arrow param default: explicit null is preserved, default not applied", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const f = (x: any = 42) => x === null ? 1 : (x === 42 ? 2 : 3);
        return f(null);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow param default: non-null non-undefined value passes through", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const f = (x: any = 42) => typeof x === "string" ? 1 : 0;
        return f("hello");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("arrow param default: numeric value passes through", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const f = (x: any = 42) => x === 7 ? 1 : 0;
        return f(7);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
