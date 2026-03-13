import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("Issue #190 — assignment target patterns", () => {
  it("property access assignment: obj.x = value", async () => {
    const result = compile(`
      export function test(): number {
        let obj = { x: 0, y: 0 };
        obj.x = 42;
        obj.y = 8;
        return obj.x + obj.y;
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

  it("element access assignment: arr[i] = value", async () => {
    const result = compile(`
      export function test(): number {
        const arr: number[] = [10, 20, 30];
        arr[0] = 100;
        arr[2] = 300;
        return arr[0] + arr[1] + arr[2];
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
    expect(exports.test()).toBe(420);
  });

  it("array destructuring assignment: [a, b] = [1, 2]", async () => {
    const result = compile(`
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        [a, b] = [10, 20];
        return a + b;
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

  it("array destructuring with omitted elements: [, b] = arr", async () => {
    const result = compile(`
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        [, b] = [10, 20];
        return b;
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
    expect(exports.test()).toBe(20);
  });

  it("object destructuring assignment: ({a, b} = obj)", async () => {
    const result = compile(`
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        const obj = { a: 100, b: 200 };
        ({a, b} = obj);
        return a + b;
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
    expect(exports.test()).toBe(300);
  });

  it("swap via array destructuring: [a, b] = [b, a]", async () => {
    const result = compile(`
      export function test(): number {
        let a: number = 1;
        let b: number = 2;
        [a, b] = [b, a];
        return a * 10 + b;
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
    // a=2, b=1 -> 2*10+1 = 21
    expect(exports.test()).toBe(21);
  });
});
