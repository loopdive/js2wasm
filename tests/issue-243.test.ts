import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRun(source: string) {
  const result = compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = {
    env: {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("Issue #243: Unsupported assignment target patterns", () => {
  it("array destructuring assignment: [a, b] = [1, 2]", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let a = 0;
        let b = 0;
        [a, b] = [10, 20];
        return a + b;
      }
    `);
    expect(exports.test()).toBe(30);
  });

  it("array destructuring with skip: [a, , c] = [1, 2, 3]", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let a = 0;
        let c = 0;
        [a, , c] = [10, 20, 30];
        return a + c;
      }
    `);
    expect(exports.test()).toBe(40);
  });

  it("object destructuring assignment: ({x, y} = obj)", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let x = 0;
        let y = 0;
        const obj = { x: 42, y: 99 };
        ({x, y} = obj);
        return x + y;
      }
    `);
    expect(exports.test()).toBe(141);
  });

  it("array destructuring in function scope", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let a = 0;
        let b = 0;
        [a, b] = [5, 15];
        return a + b;
      }
    `);
    expect(exports.test()).toBe(20);
  });

  it("array destructuring with rest: [first, ...rest] from array source", async () => {
    const exports = await compileAndRun(`
      function makeArr(): number[] { return [10, 20, 30]; }
      export function test(): number {
        let first = 0;
        let rest: number[] = [];
        [first, ...rest] = makeArr();
        return first + rest.length + rest[0] + rest[1];
      }
    `);
    expect(exports.test()).toBe(62); // 10 + 2 + 20 + 30
  });

  it("nested object destructuring assignment", async () => {
    const exports = await compileAndRun(`
      export function test(): number {
        let b = 0;
        const obj = { a: { b: 77 } };
        let a: { b: number } = { b: 0 };
        ({a} = obj);
        return a.b;
      }
    `);
    expect(exports.test()).toBe(77);
  });
});
