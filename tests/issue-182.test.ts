import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(source: string, fnName = "test") {
  const result = compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any)[fnName]();
}

describe("issue-182: arrow function closure type coercion", () => {
  it("arrow function assigned to var and called (mutable capture)", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        var callCount = 0;
        var ref: (x: number) => void;
        ref = (x: number) => {
          callCount = callCount + 1;
        };
        ref(3);
        return callCount;
      }
    `);
    expect(val).toBe(1);
  }, 30000);

  it("arrow function with default params referencing prior params", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        var result = 0;
        var ref: (x: number, y?: number, z?: number) => void;
        ref = (x: number, y: number = x, z: number = y) => {
          result = x + y + z;
        };
        ref(3);
        return result;
      }
    `);
    expect(val).toBe(9);
  }, 30000);

  it("arrow function declared inline with var (mutable capture)", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        var callCount = 0;
        var ref = (x: number) => {
          callCount = callCount + 1;
        };
        ref(3);
        return callCount;
      }
    `);
    expect(val).toBe(1);
  }, 30000);

  it("arrow function captures outer variable (read-only)", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        var outer = 10;
        var ref = (x: number) => {
          return outer + x;
        };
        return ref(5);
      }
    `);
    expect(val).toBe(15);
  }, 30000);

  it("closure captures and uses variable in arithmetic", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        var result = 0;
        var multiplier = 3;
        var fn = (x: number) => {
          result = x * multiplier;
        };
        fn(5);
        return result;
      }
    `);
    expect(val).toBe(15);
  }, 30000);

  it("void closure call does not roll back instructions", async () => {
    // This is the core bug: void closure calls returned null instead of
    // VOID_RESULT, causing compileExpression to treat it as a compilation
    // failure and roll back the emitted call_ref instructions
    const val = await compileAndRun(`
      export function test(): number {
        var x = 0;
        var inc = () => { x = x + 1; };
        inc();
        inc();
        inc();
        return x;
      }
    `);
    expect(val).toBe(3);
  }, 30000);

  it("closure call with return value works", async () => {
    const val = await compileAndRun(`
      export function test(): number {
        var add = (a: number, b: number) => a + b;
        return add(10, 20);
      }
    `);
    expect(val).toBe(30);
  }, 30000);
});
