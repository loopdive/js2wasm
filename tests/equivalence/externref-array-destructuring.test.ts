import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

describe("externref array destructuring (#518)", () => {
  it("destructure any-typed variable compiles without array-type error", () => {
    const source = `
      export function test(): number {
        const arr: any = [5, 15];
        const [x, y] = arr;
        return 0;
      }
    `;
    const result = compile(source);
    const destructErrors = result.errors.filter(e =>
      e.message.includes("Cannot destructure") && e.message.includes("not an array")
    );
    expect(destructErrors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("destructure any-typed function return compiles without array-type error", () => {
    const source = `
      function getArray(): any {
        return [10, 20, 30];
      }
      export function test(): number {
        const [a, b, c] = getArray();
        return 0;
      }
    `;
    const result = compile(source);
    const destructErrors = result.errors.filter(e =>
      e.message.includes("Cannot destructure") && e.message.includes("not an array")
    );
    expect(destructErrors).toEqual([]);
  });

  it("destructure assignment with any-typed source compiles without array-type error", () => {
    const source = `
      export function test(): number {
        let a: any, b: any;
        const src: any = [7, 8];
        [a, b] = src;
        return 0;
      }
    `;
    const result = compile(source);
    const destructErrors = result.errors.filter(e =>
      e.message.includes("Cannot destructure") && e.message.includes("not an array")
    );
    expect(destructErrors).toEqual([]);
  });

  it("existing array destructuring still works", () => {
    const source = `
      export function test(): number {
        const [a, b, c] = [1, 2, 3];
        return a + b + c;
      }
    `;
    const result = compile(source);
    expect(result.success).toBe(true);
    const destructErrors = result.errors.filter(e =>
      e.message.includes("Cannot destructure")
    );
    expect(destructErrors).toEqual([]);
  });

  it("non-struct ref destructuring falls back to externref", () => {
    // When a ref type is not a struct, we convert to externref and use __extern_get
    const source = `
      function getVal(): any { return [1, 2]; }
      export function test(): number {
        const x: any = getVal();
        const [a, b] = x;
        return 0;
      }
    `;
    const result = compile(source);
    const destructErrors = result.errors.filter(e =>
      e.message.includes("Cannot destructure") && e.message.includes("not an array")
    );
    expect(destructErrors).toEqual([]);
  });
});
