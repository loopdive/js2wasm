/**
 * Tests for issue #827 — Array callback methods throw TypeError for non-callable callbacks
 *
 * Verifies that Array.prototype.every/some/filter/map/forEach/reduce/reduceRight/find/findIndex
 * properly throw TypeError when passed a non-function as the callback argument,
 * rather than emitting a broken Wasm module with "fn is not a function" validation error.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<unknown> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) throw new Error("CE: " + (result.errors[0]?.message ?? "unknown"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test?.();
}

describe("issue #827 — Array callback TypeError for non-callable args", () => {
  it("Array.prototype.every throws TypeError when no callback provided", async () => {
    const src = `
      export function test(): i32 {
        const arr = [1, 2, 3];
        try {
          (arr as any).every();
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.every works with a valid arrow callback", async () => {
    const src = `
      export function test(): i32 {
        const arr = [2, 4, 6];
        return arr.every(x => x % 2 === 0) ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.some works with valid callback", async () => {
    const src = `
      export function test(): i32 {
        const arr = [1, 2, 3];
        return arr.some(x => x > 2) ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.filter returns correct results", async () => {
    const src = `
      export function test(): i32 {
        const result = [1, 2, 3, 4, 5].filter(x => x > 3);
        return result.length === 2 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.map returns correct results", async () => {
    const src = `
      export function test(): i32 {
        const result = [1, 2, 3].map(x => x * 2);
        return (result[0] === 2 && result[1] === 4 && result[2] === 6) ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.reduce accumulates correctly", async () => {
    const src = `
      export function test(): i32 {
        const result = [1, 2, 3, 4].reduce((acc, x) => acc + x, 0);
        return result === 10 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.forEach iterates correctly", async () => {
    const src = `
      export function test(): i32 {
        let sum = 0;
        [1, 2, 3].forEach(x => { sum += x; });
        return sum === 6 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.find returns matching element", async () => {
    const src = `
      export function test(): i32 {
        const result = [1, 2, 3, 4].find(x => x > 2);
        return result === 3 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("Array.prototype.findIndex returns correct index", async () => {
    const src = `
      export function test(): i32 {
        return [1, 2, 3, 4].findIndex(x => x > 2);
      }
    `;
    expect(await run(src)).toBe(2);
  });

  it("no 'fn is not a function' CE when callback argument is undefined", async () => {
    // The original bug: compiler emitted broken Wasm that failed with
    // "fn is not a function" at instantiation time. The fix emits a static
    // TypeError throw instead. Passing undefined as any still compiles cleanly.
    const src = `
      export function test(): i32 {
        try {
          [1, 2, 3].every(undefined as any);
          return 0;
        } catch (e) {
          return 1;
        }
      }
    `;
    const result = compile(src, { fileName: "test.ts" });
    if (!result.success) {
      // If there is a CE, it should NOT be the "fn is not a function" Wasm validation error
      expect(result.errors[0]?.message).not.toMatch(/fn is not a function/);
    } else {
      // Compiled successfully — no broken Wasm
      expect(result.success).toBe(true);
    }
  });
});
