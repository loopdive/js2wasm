import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("default parameter values", () => {
  it("numeric default value is used when argument is omitted", { timeout: 15000 }, async () => {
    const result = compile(`
      function foo(x: number = 42): number {
        return x;
      }
      export function test(): number {
        return foo();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(42);
  });

  it("numeric default value is overridden when argument is provided", { timeout: 15000 }, async () => {
    const result = compile(`
      function foo(x: number = 42): number {
        return x;
      }
      export function test(): number {
        return foo(99);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(99);
  });

  it("multiple numeric defaults", { timeout: 15000 }, async () => {
    const result = compile(`
      function add(a: number = 1, b: number = 2): number {
        return a + b;
      }
      export function noArgs(): number {
        return add();
      }
      export function oneArg(): number {
        return add(10);
      }
      export function twoArgs(): number {
        return add(10, 20);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.noArgs()).toBe(3); // 1 + 2
    expect(exports.oneArg()).toBe(12); // 10 + 2
    expect(exports.twoArgs()).toBe(30); // 10 + 20
  });

  it("string default value is used when argument is omitted", { timeout: 15000 }, async () => {
    const result = compile(`
      function greet(name: string = "world"): string {
        return "Hello " + name;
      }
      export function test(): string {
        return greet();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe("Hello world");
  });

  it("string default value is overridden when argument is provided", { timeout: 15000 }, async () => {
    const result = compile(`
      function greet(name: string = "world"): string {
        return "Hello " + name;
      }
      export function test(): string {
        return greet("Bob");
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe("Hello Bob");
  });

  it("mixed required and default params", { timeout: 15000 }, async () => {
    const result = compile(`
      function calc(base: number, multiplier: number = 10): number {
        return base * multiplier;
      }
      export function withDefault(): number {
        return calc(5);
      }
      export function withOverride(): number {
        return calc(5, 3);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.withDefault()).toBe(50); // 5 * 10
    expect(exports.withOverride()).toBe(15); // 5 * 3
  });

  it("boolean default value (true)", { timeout: 15000 }, async () => {
    const result = compile(`
      function check(flag: boolean = true): number {
        if (flag) {
          return 1;
        }
        return 0;
      }
      export function withDefault(): number {
        return check();
      }
      export function withTrue(): number {
        return check(true);
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.withDefault()).toBe(1);
    expect(exports.withTrue()).toBe(1);
  });

  it("expression as default value", { timeout: 15000 }, async () => {
    const result = compile(`
      function doubleOrDefault(x: number = 3 + 4): number {
        return x * 2;
      }
      export function test(): number {
        return doubleOrDefault();
      }
    `);
    expect(
      result.success,
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
    ).toBe(true);

    const { instance } = await WebAssembly.instantiate(
      result.binary,
      buildImports(result.imports, undefined, result.stringPool),
    );
    const exports = instance.exports as any;
    expect(exports.test()).toBe(14); // (3+4) * 2
  });
});
