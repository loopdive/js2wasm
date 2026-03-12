import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs, assertEquivalent, buildImports, compile, readFileSync, resolve } from "./helpers.js";

describe("Unary plus coercion (#215)", () => {
  it('+\"\" should be 0', async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +"";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("+true should be 1", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +true;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("+false should be 0", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +false;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it('+\"123\" should be 123', async () => {
    await assertEquivalent(
      `
      export function test(): number {
        return +"123";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
