import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #369: globalThis support", () => {
  it("compiles globalThis reference without errors", () => {
    const result = compile(`
      export function test(): any {
        return globalThis;
      }
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("compiles typeof globalThis without errors", () => {
    const result = compile(`
      export function test(): string {
        return typeof globalThis;
      }
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("compiles globalThis equality check without errors", () => {
    const result = compile(`
      export function test(): boolean {
        return globalThis === undefined;
      }
    `);
    expect(result.errors).toHaveLength(0);
  });

  it("compiles globalThis in conditional without errors", () => {
    const result = compile(`
      export function test(): number {
        if (globalThis) {
          return 1;
        }
        return 0;
      }
    `);
    expect(result.errors).toHaveLength(0);
  });
});
