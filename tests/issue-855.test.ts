import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`CE: ${r.errors.map((e) => e.message).join("\n")}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

function compileOnly(src: string): { success: boolean; errors?: any[]; imports?: any[] } {
  return compile(src, { fileName: "test.ts" });
}

describe("#855 — Promise v2", () => {
  it("Promise.resolve compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.resolve(42);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Promise.reject compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.reject("err");
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Promise.allSettled compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.allSettled([Promise.resolve(1)]);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Promise.any compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.any([Promise.resolve(1)]);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("new Promise(executor) compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = new Promise((resolve) => resolve(42));
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it(".then() chains compile and run", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.resolve(42).then((x: number) => x + 1);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it(".then(cb1, cb2) two-callback form compiles", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.resolve(1).then((x: number) => x + 1, (err: any) => 0);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it(".catch() compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.resolve(42).catch((e: any) => 0);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it(".finally() compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.resolve(42).finally(() => {});
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Promise.all compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.all([Promise.resolve(1), Promise.resolve(2)]);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Promise.race compiles and runs", async () => {
    const result = await compileAndRun(`
      export function test(): number {
        const p = Promise.race([Promise.resolve(1), Promise.resolve(2)]);
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("async function call wraps result in Promise", async () => {
    const result = await compileAndRun(`
      async function foo(): Promise<number> {
        return 42;
      }
      export function test(): number {
        const p = foo();
        return 1;
      }
    `);
    expect(result).toBe(1);
  });

  it("Promise.resolve registers the import correctly", () => {
    const r = compileOnly(`
      export function test(): number {
        const p = Promise.resolve(42);
        return 1;
      }
    `);
    expect(r.success).toBe(true);
    const promiseImports = r.imports?.filter((i: any) => i.name?.startsWith("Promise_"));
    expect(promiseImports?.length).toBeGreaterThan(0);
  });
});
