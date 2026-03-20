import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("boolean relational comparison", () => {
  it("true > false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (true > false) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("false < true", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (false < true) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("true >= true", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (true >= true) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("false <= false", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return (false <= false) ? 1 : 0;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
