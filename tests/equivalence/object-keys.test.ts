import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("Object.keys", () => {
  it("compiles and returns empty array for any-typed argument", async () => {
    await assertEquivalent(
      `
      function getObj(): any {
        return 42;
      }
      export function test(): number {
        return Object.keys(getObj()).length;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  }, 15000);
});
