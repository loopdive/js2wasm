import { describe, it, expect } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("Issue #666: await outside async should not block compilation", () => {
  it("compiles code with top-level await pattern", async () => {
    // Should compile without error (await in non-async is downgraded to warning)
    const result = compile(
      `
      async function fetchData(): Promise<number> {
        return 42;
      }
      export async function test(): Promise<number> {
        const val = await fetchData();
        return val;
      }
      `,
      { fast: true },
    );
    expect(result.errors.length).toBe(0);
  });
});

describe("Issue #667: hint is not defined (spread in expression position)", () => {
  it("compiles spread element without ReferenceError", async () => {
    // The spread element fallback path referenced 'hint' which was not in scope
    const result = compile(
      `
      function sum(...args: number[]): number {
        let total = 0;
        for (const a of args) total += a;
        return total;
      }
      export function test(): number {
        const nums = [1, 2, 3];
        return sum(...nums);
      }
      `,
      { fast: true },
    );
    // Should not have "hint is not defined" error
    const hintError = result.errors.find((e: any) => e.message?.includes("hint"));
    expect(hintError).toBeUndefined();
  });
});

describe("Issue #668: empty string literal registration", () => {
  it("template expression with empty head compiles", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const x = 42;
        return \`\${x} items\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("empty string literal compiles", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        return "";
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("template with empty spans compiles", async () => {
    await assertEquivalent(
      `
      export function test(): string {
        const a = "hello";
        const b = "world";
        return \`\${a}\${b}\`;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
