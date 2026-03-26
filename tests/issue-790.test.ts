import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<any> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error("Compile error: " + result.errors.map(e => e.message).join("; "));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #790: ReferenceError for TDZ violations", () => {
  it("should throw when accessing let variable before initialization", async () => {
    const src = `
      export function test(): number {
        let threw = false;
        try {
          let val = x;
          let x = 10;
        } catch (e) {
          threw = true;
        }
        return threw ? 1 : 0;
      }
    `;
    const result = await compileAndRun(src);
    expect(result).toBe(1);
  });

  it("should throw when accessing const variable before initialization", async () => {
    const src = `
      export function test(): number {
        let threw = false;
        try {
          let val = y;
          const y = 20;
        } catch (e) {
          threw = true;
        }
        return threw ? 1 : 0;
      }
    `;
    const result = await compileAndRun(src);
    expect(result).toBe(1);
  });

  it("should not throw when accessing let variable after initialization", async () => {
    const src = `
      export function test(): number {
        let x = 10;
        return x;
      }
    `;
    const result = await compileAndRun(src);
    expect(result).toBe(10);
  });

  it("should throw ReferenceError with proper message for TDZ", async () => {
    const src = `
      export function test(): number {
        let threw = false;
        let msg = "";
        try {
          let val = z;
          let z = 30;
        } catch (e: any) {
          threw = true;
          // The error message should contain "Cannot access" or "before initialization"
          if (typeof e === "string") {
            msg = e;
          }
        }
        return threw ? 1 : 0;
      }
    `;
    const result = await compileAndRun(src);
    expect(result).toBe(1);
  });

  it("should handle TDZ in nested blocks", async () => {
    const src = `
      export function test(): number {
        let threw = false;
        try {
          {
            let val = a;
            let a = 5;
          }
        } catch (e) {
          threw = true;
        }
        return threw ? 1 : 0;
      }
    `;
    const result = await compileAndRun(src);
    expect(result).toBe(1);
  });

  it("should handle TDZ in for loop initializer", async () => {
    const src = `
      export function test(): number {
        let count = 0;
        for (let i = 0; i < 3; i++) {
          count = count + i;
        }
        return count;
      }
    `;
    const result = await compileAndRun(src);
    expect(result).toBe(3);
  });
});
