import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("import.meta support", () => {
  it("import.meta.url returns a string", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return import.meta.url;
      }
    `);
    const result = exports.test();
    expect(typeof result).toBe("string");
    expect(result).toBe("module.wasm");
  });

  it("typeof import.meta returns 'object'", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (typeof import.meta === "object") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("import.meta is truthy", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (import.meta) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("import.meta.url can be stored in a variable", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        const url = import.meta.url;
        return url;
      }
    `);
    expect(exports.test()).toBe("module.wasm");
  });
});
