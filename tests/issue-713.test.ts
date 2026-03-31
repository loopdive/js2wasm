import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #713: Cannot destructure: unknown type", () => {
  it("object destructuring with unknown source type compiles (JS mode)", () => {
    const result = compile(
      `
      function test(x) {
        var { a, b } = x;
        return a;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    const unknownErrors = result.errors.filter((e) => e.message.includes("Cannot destructure: unknown type"));
    expect(unknownErrors).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("object destructuring with any-typed source compiles", () => {
    const result = compile(`
      function getValue(): any {
        return { x: 1, y: 2 };
      }
      export function test(): number {
        const { x, y } = getValue();
        return 0;
      }
    `);
    const unknownErrors = result.errors.filter((e) => e.message.includes("Cannot destructure: unknown type"));
    expect(unknownErrors).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("object destructuring with default values on unknown type compiles", () => {
    const result = compile(`
      function getValue(): any {
        return { a: 1 };
      }
      export function test(): number {
        const { a = 0, b = 0 } = getValue();
        return 0;
      }
    `);
    const unknownErrors = result.errors.filter((e) => e.message.includes("Cannot destructure: unknown type"));
    expect(unknownErrors).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("array destructuring with unknown source type compiles (JS mode)", () => {
    const result = compile(
      `
      function test(x) {
        var [a, b] = x;
        return a;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    const unknownErrors = result.errors.filter((e) => e.message.includes("Cannot destructure"));
    expect(unknownErrors).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("const destructuring with null initializer compiles", () => {
    // Pattern from test262: const/dstr/obj-init-null.js
    const result = compile(`
      export function test(): number {
        try {
          const {} = null as any;
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    // Should compile (may throw at runtime, but should not be a compile error)
    const unknownErrors = result.errors.filter((e) => e.message.includes("Cannot destructure: unknown type"));
    expect(unknownErrors).toHaveLength(0);
  });
});
