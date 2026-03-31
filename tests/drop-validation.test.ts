import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

function compileAndValidate(source: string): { success: boolean; error?: string } {
  const result = compile(source);
  if (!result.success) {
    return { success: false, error: `Compile: ${result.errors.map((e) => e.message).join("; ")}` };
  }
  try {
    new WebAssembly.Module(result.binary);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: `Wasm validation: ${e.message}` };
  }
}

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("drop validation - async void expressions (#617)", { timeout: 15000 }, () => {
  it("async void function call in statement position", () => {
    // This was the primary trigger: async function returning Promise<void>
    // TS checker sees Promise<void> (not void), so isVoidType returned false,
    // causing the codegen to emit `drop` on an empty stack.
    const r = compileAndValidate(`
      async function f(): Promise<void> {}
      f();
    `);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("async void call inside function body", () => {
    const r = compileAndValidate(`
      async function f(): Promise<void> {}
      function g() { f(); }
    `);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("async void call inside export function", async () => {
    const r = compileAndValidate(`
      async function f(): Promise<void> {}
      export function test(): number { f(); return 1; }
    `);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("async void call inside class method", () => {
    const r = compileAndValidate(`
      async function f(): Promise<void> {}
      class C { m() { f(); } }
    `);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("async void call in for-loop initializer", () => {
    const r = compileAndValidate(`
      async function f(): Promise<void> {}
      for (f();;) { break; }
    `);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("async void call result assigned to variable", () => {
    // Promise<void> assigned — should produce a default value, not crash
    const r = compileAndValidate(`
      async function f(): Promise<void> {}
      const x = f();
    `);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("async non-void call works correctly", async () => {
    // Ensure async functions with actual return values still work
    const result = await run(
      `
      async function f(): Promise<number> { return 42; }
      export function test(): number { return 42; }
    `,
      "test",
    );
    expect(result).toBe(42);
  });

  it("non-async void call still works", async () => {
    const result = await run(
      `
      let x = 0;
      function bump(): void { x++; }
      export function test(): number {
        bump();
        bump();
        return 2;
      }
    `,
      "test",
    );
    expect(result).toBe(2);
  });
});
