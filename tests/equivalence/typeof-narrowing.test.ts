import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

describe("typeof narrowing (#683)", () => {
  it("typeof x === 'string' narrows to string, accesses .length", async () => {
    await assertEquivalent(
      `export function test(x: any): number {
        if (typeof x === "string") {
          return x.length;
        }
        return -1;
      }`,
      [
        { fn: "test", args: ["hello"] },
        { fn: "test", args: [""] },
        { fn: "test", args: [42] },
      ],
    );
  });

  it("typeof x === 'number' narrows to number, does arithmetic", async () => {
    await assertEquivalent(
      `export function test(x: any): number {
        if (typeof x === "number") {
          return x + 10;
        }
        return -1;
      }`,
      [
        { fn: "test", args: [5] },
        { fn: "test", args: [0] },
        { fn: "test", args: ["hello"] },
      ],
    );
  });

  it("typeof x !== 'number' narrows in else branch", async () => {
    await assertEquivalent(
      `export function test(x: any): number {
        if (typeof x !== "number") {
          return -1;
        } else {
          return x * 2;
        }
      }`,
      [
        { fn: "test", args: [7] },
        { fn: "test", args: ["hi"] },
      ],
    );
  });

  it("typeof narrowing with string concatenation", async () => {
    await assertEquivalent(
      `export function test(x: any): string {
        if (typeof x === "string") {
          return x + " world";
        }
        return "not a string";
      }`,
      [
        { fn: "test", args: ["hello"] },
        { fn: "test", args: [42] },
      ],
    );
  });

  it("typeof narrowing does not leak outside if block", async () => {
    await assertEquivalent(
      `export function test(x: any): number {
        let result = 0;
        if (typeof x === "number") {
          result = x + 1;
        }
        return result;
      }`,
      [
        { fn: "test", args: [10] },
        { fn: "test", args: ["hi"] },
      ],
    );
  });
});
