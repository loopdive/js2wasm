import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("new Function() compiles without errors (#711)", () => {
  it("new Function('return 1') compiles to a no-op externref", () => {
    const result = compile(`
      export function test(): number {
        const f = new Function("return 1");
        return 42;
      }
    `);
    // Should compile without errors related to "Unsupported new expression"
    const newFuncErrors = (result.errors ?? []).filter(e =>
      e.message.includes("Unsupported new expression") && e.message.includes("Function")
    );
    expect(newFuncErrors).toHaveLength(0);
  });

  it("new Function with multiple args compiles", () => {
    const result = compile(`
      export function test(): number {
        const add = new Function("a", "b", "return a + b");
        return 42;
      }
    `);
    const newFuncErrors = (result.errors ?? []).filter(e =>
      e.message.includes("Unsupported new expression") && e.message.includes("Function")
    );
    expect(newFuncErrors).toHaveLength(0);
  });

  it("new Function with no args compiles", () => {
    const result = compile(`
      export function test(): number {
        const f = new Function();
        return 42;
      }
    `);
    const newFuncErrors = (result.errors ?? []).filter(e =>
      e.message.includes("Unsupported new expression") && e.message.includes("Function")
    );
    expect(newFuncErrors).toHaveLength(0);
  });
});
