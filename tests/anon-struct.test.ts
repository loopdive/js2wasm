import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("anonymous object types", () => {
  it("function returning anonymous object type", async () => {
    const result = compile(`
      function makePoint(x: number, y: number): { x: number; y: number } {
        return { x: x, y: y };
      }
      export function test(): number {
        const p = makePoint(3, 4);
        return p.x + p.y;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);
    expect(result.wat).toContain("struct");

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(7);
  });

  it("destructuring declaration with anonymous return type", async () => {
    const result = compile(`
      function makePoint(x: number, y: number): { x: number; y: number } {
        return { x: x, y: y };
      }
      export function test(): number {
        const { x, y } = makePoint(10, 20);
        return x + y;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(30);
  });

  it("destructuring assignment into existing locals", async () => {
    const result = compile(`
      function makeSize(w: number, h: number): { width: number; height: number } {
        return { width: w, height: h };
      }
      export function test(): number {
        let width: number;
        let height: number;
        ({ width, height } = makeSize(5, 10));
        return width * height;
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {
        console_log_number: () => {},
        console_log_bool: () => {},
      },
    });
    const exports = instance.exports as any;
    expect(exports.test()).toBe(50);
  });

  it("import statement is ignored gracefully", () => {
    const result = compile(`
      import * as THREE from "three";
      export function test(): number {
        return 42;
      }
    `);
    // Should compile (import is ignored), though there will be a tsc diagnostic
    expect(result.success).toBe(true);
    const exports_check = result.wat.includes("func $test");
    expect(exports_check).toBe(true);
  });
});
