import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runFast(source: string, exportName = "test"): Promise<any> {
  const result = compile(source, { fast: true });
  if (!result.success) throw new Error(result.errors.map(e => e.message).join("\n"));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env);
  return (instance.exports[exportName] as Function)();
}

describe("fast mode: i32 default numbers", () => {
  it("integer literal returns correct value", async () => {
    expect(await runFast(`export function test(): number { return 42; }`)).toBe(42);
  });

  it("integer addition", async () => {
    expect(await runFast(`export function test(): number { return 10 + 32; }`)).toBe(42);
  });

  it("integer subtraction", async () => {
    expect(await runFast(`export function test(): number { return 50 - 8; }`)).toBe(42);
  });

  it("integer multiplication", async () => {
    expect(await runFast(`export function test(): number { return 6 * 7; }`)).toBe(42);
  });

  it("integer modulo", async () => {
    expect(await runFast(`export function test(): number { return 10 % 3; }`)).toBe(1);
  });

  it("integer comparison (less than)", async () => {
    expect(await runFast(`export function test(): number { return 3 < 5 ? 1 : 0; }`)).toBe(1);
  });

  it("integer comparison (equals)", async () => {
    expect(await runFast(`export function test(): number { return 42 === 42 ? 1 : 0; }`)).toBe(1);
  });

  it("loop counter stays i32", async () => {
    const src = `export function test(): number {
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        sum = sum + i;
      }
      return sum;
    }`;
    expect(await runFast(src)).toBe(45);
  });

  it("function params are i32", async () => {
    const src = `export function test(): number {
      return add(20, 22);
    }
    function add(a: number, b: number): number { return a + b; }`;
    expect(await runFast(src)).toBe(42);
  });

  it("bitwise operations are direct (no f64 conversion)", async () => {
    const src = `export function test(): number { return (0xFF & 0x0F) | 0x30; }`;
    expect(await runFast(src)).toBe(0x3F);
  });

  it("negative numbers work", async () => {
    expect(await runFast(`export function test(): number { return -5 + 3; }`)).toBe(-2);
  });

  it("WAT uses i32 ops instead of f64", () => {
    const result = compile(
      `export function test(): number { return 1 + 2; }`,
      { fast: true },
    );
    expect(result.success).toBe(true);
    // WAT should contain i32 operations, not f64
    expect(result.wat).toContain("i32.const");
    expect(result.wat).toContain("i32.add");
    expect(result.wat).not.toContain("f64.const 1");
    expect(result.wat).not.toContain("f64.add");
  });

  it("non-fast mode still uses f64", () => {
    const result = compile(
      `export function test(): number { return 1 + 2; }`,
    );
    expect(result.success).toBe(true);
    expect(result.wat).toContain("f64.const");
    expect(result.wat).toContain("f64.add");
  });
});
