/**
 * Issue #844 — Unsupported new expression for built-in classes
 * Tests that new AggregateError() compiles without errors.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

describe("Issue #844: new AggregateError compiles", () => {
  it("new AggregateError([], message) compiles", () => {
    const source = `
      export function test(): number {
        const err = new AggregateError([], "my-message");
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const unsupported = result.errors.filter((e) => e.message.includes("Unsupported new expression"));
    expect(unsupported).toHaveLength(0);
  });

  it("new AggregateError([]) with no message compiles", () => {
    const source = `
      export function test(): number {
        const err = new AggregateError([]);
        return 1;
      }
    `;
    const result = compile(source, { fileName: "test.ts" });
    expect(result.success).toBe(true);
    const unsupported = result.errors.filter((e) => e.message.includes("Unsupported new expression"));
    expect(unsupported).toHaveLength(0);
  });
});
