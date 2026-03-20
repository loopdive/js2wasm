import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("numeric index signature on object types (#391)", () => {
  it("numeric literal property access via struct.get", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {0: 10, 1: 20, length: 2};
        return obj[0];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string literal index on object with known keys", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {x: 10, y: 20};
        return obj["x"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("multiple numeric index accesses", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {0: 5, 1: 15, 2: 25};
        return obj[0] + obj[1] + obj[2];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("numeric index with length property", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        var obj = {0: 100, 1: 200, length: 2};
        return obj[1] + obj["length"];
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
