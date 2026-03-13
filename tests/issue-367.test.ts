import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string = "test", args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fn](...args);
}

describe("issue-367: string variable concatenation in comparisons", () => {
  it("concatenates two string variables", async () => {
    expect(await run(`
      export function test(): string {
        var a = "hello";
        var b = "world";
        return a + b;
      }
    `)).toBe("helloworld");
  });

  it("concatenates string variable with literal", async () => {
    expect(await run(`
      export function test(): string {
        var a = "hello";
        return a + " world";
      }
    `)).toBe("hello world");
  });

  it("three-part concatenation", async () => {
    expect(await run(`
      export function test(): string {
        var a = "hello";
        var b = "world";
        return a + " " + b;
      }
    `)).toBe("hello world");
  });

  it("concatenated string equals literal with ===", async () => {
    expect(await run(`
      export function test(): number {
        var a = "hello";
        var b = "world";
        var result = a + " " + b;
        if (result === "hello world") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("concatenated string used directly in === comparison", async () => {
    expect(await run(`
      export function test(): number {
        var a = "hello";
        var b = "world";
        if (a + " " + b === "hello world") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("concatenated string not equal to wrong value", async () => {
    expect(await run(`
      export function test(): number {
        var a = "hello";
        var b = "world";
        if (a + " " + b !== "hello world") return 0;
        return 1;
      }
    `)).toBe(1);
  });

  it("multiple concatenations compared", async () => {
    expect(await run(`
      export function test(): number {
        var x = "ab";
        var y = "cd";
        var z = "ef";
        var result = x + y + z;
        if (result === "abcdef") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("concatenation with empty string", async () => {
    expect(await run(`
      export function test(): number {
        var a = "hello";
        var b = "";
        if (a + b === "hello") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("string += concatenation", async () => {
    expect(await run(`
      export function test(): string {
        var result = "hello";
        result += " world";
        return result;
      }
    `)).toBe("hello world");
  });

  it("string += with variable", async () => {
    expect(await run(`
      export function test(): string {
        var result = "hello";
        var suffix = " world";
        result += suffix;
        return result;
      }
    `)).toBe("hello world");
  });

  it("string += then compare with ===", async () => {
    expect(await run(`
      export function test(): number {
        var result = "";
        result += "hello";
        result += " ";
        result += "world";
        if (result === "hello world") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("string += in loop", async () => {
    expect(await run(`
      export function test(): string {
        var result = "";
        var items = "abc";
        for (var i = 0; i < 3; i++) {
          result += items[i];
        }
        return result;
      }
    `)).toBe("abc");
  });

  it("string var initialized then += variable", async () => {
    expect(await run(`
      export function test(): number {
        var s = "a";
        var t = "b";
        s += t;
        if (s === "ab") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("string += builds up and compares with sameValue pattern", async () => {
    expect(await run(`
      export function test(): number {
        var result = "";
        result += "x";
        result += "y";
        result += "z";
        // Simulating assert.sameValue(result, "xyz")
        if (result === "xyz") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("string += with number coercion", async () => {
    expect(await run(`
      export function test(): number {
        var s: string = "";
        s += 1;
        s += 2;
        s += 3;
        if (s === "123") return 1;
        return 0;
      }
    `)).toBe(1);
  });

  it("string var with non-string += elsewhere (false positive pattern)", async () => {
    // This is the test262 pattern: a string var exists, but += is on a different numeric var
    expect(await run(`
      export function test(): number {
        let length: string = "outer";
        var iterCount: number = 0;
        iterCount += 1;
        if (length === "outer" && iterCount === 1) return 1;
        return 0;
      }
    `)).toBe(1);
  });
});
