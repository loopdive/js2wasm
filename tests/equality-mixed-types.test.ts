import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("equality operators with mixed types (#433)", () => {
  it("true == object with valueOf returning 1", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 1; } };
        return (true == obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("1 == object with valueOf returning 1", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 1; } };
        return (1 == obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("false == object with valueOf returning 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 0; } };
        return (false == obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object with valueOf != boolean", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 1; } };
        return (obj != false) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("true !== object (strict, always true)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 1; } };
        return (true !== obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("true === object (strict, always false)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 1; } };
        return (true === obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("number == object with valueOf returning same number", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 42; } };
        return (42 == obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("number != object with valueOf returning different number", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        const obj = { valueOf() { return 5; } };
        return (10 != obj) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
