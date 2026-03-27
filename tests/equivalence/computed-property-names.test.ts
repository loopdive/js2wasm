import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("computed property names", () => {
  it("string literal as computed key", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { ["x"]: 42 };
        return obj.x;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("variable as computed key", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const key = "value";
        const obj = { [key]: 99 };
        return obj.value;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("expression as computed key", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const prefix = "prop";
        const obj = { [prefix + "A"]: 10, [prefix + "B"]: 20 };
        return obj.propA + obj.propB;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("computed key with number-to-string", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const idx = 0;
        const obj: Record<string, number> = { [idx]: 55 };
        return obj[0];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("mixed computed and static keys", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const k = "dynamic";
        const obj = { static_key: 1, [k]: 2 };
        return obj.static_key + obj.dynamic;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
