import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
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

describe("issue-349: String() constructor as function", () => {
  it("String(42) returns '42'", async () => {
    const val = await run(`
      export function test(): string { return String(42); }
    `, "test");
    expect(val).toBe("42");
  });

  it("String(0) returns '0'", async () => {
    const val = await run(`
      export function test(): string { return String(0); }
    `, "test");
    expect(val).toBe("0");
  });

  it("String(-1) returns '-1'", async () => {
    const val = await run(`
      export function test(): string { return String(-1); }
    `, "test");
    expect(val).toBe("-1");
  });

  it("String(3.14) returns '3.14'", async () => {
    const val = await run(`
      export function test(): string { return String(3.14); }
    `, "test");
    expect(val).toBe("3.14");
  });

  it("String(true) returns 'true'", async () => {
    const val = await run(`
      export function test(): string { return String(true); }
    `, "test");
    expect(val).toBe("true");
  });

  it("String(false) returns 'false'", async () => {
    const val = await run(`
      export function test(): string { return String(false); }
    `, "test");
    expect(val).toBe("false");
  });

  it("String(null) returns 'null'", async () => {
    const val = await run(`
      export function test(): string { return String(null); }
    `, "test");
    expect(val).toBe("null");
  });

  it("String(undefined) returns 'undefined'", async () => {
    const val = await run(`
      export function test(): string { return String(undefined); }
    `, "test");
    expect(val).toBe("undefined");
  });

  it("String() with no args returns empty string", async () => {
    const val = await run(`
      export function test(): string { return String(); }
    `, "test");
    expect(val).toBe("");
  });

  it("String('hello') returns 'hello' (passthrough)", async () => {
    const val = await run(`
      export function test(): string { return String("hello"); }
    `, "test");
    expect(val).toBe("hello");
  });

  it("String with boolean variable", async () => {
    const val = await run(`
      export function test(): string {
        const b: boolean = true;
        return String(b);
      }
    `, "test");
    expect(val).toBe("true");
  });

  it("String with number variable", async () => {
    const val = await run(`
      export function test(): string {
        const n: number = 123;
        return String(n);
      }
    `, "test");
    expect(val).toBe("123");
  });
});
