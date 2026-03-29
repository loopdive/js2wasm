import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runWasm(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("Compile: " + r.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

async function compileAndRun(src: string): Promise<{ result: any; errors: string[] }> {
  const r = compile(src, { fileName: "test.ts" });
  const errors = r.errors.map((e) => e.message);
  if (!r.success) return { result: undefined, errors };
  try {
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return { result: (instance.exports as any).test(), errors };
  } catch (e: any) {
    return { result: "IE:" + e.message?.slice(0, 100), errors };
  }
}

describe("#846 -- const assignment throws TypeError", () => {
  it("const x = 1; x = 2 throws in try-catch", async () => {
    // TS reports a compile error but still emits code; the runtime should throw
    const { result } = await compileAndRun(`
      var threw = false;
      function tryAssign(): void {
        const x = 1;
        try {
          x = 2;
        } catch (e) {
          threw = true;
        }
      }
      tryAssign();
      export function test(): number { return threw ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("for (const x of arr) { x++ } throws TypeError", async () => {
    const { result } = await compileAndRun(`
      var threw = false;
      function tryInc(): void {
        try {
          for (const x of [1, 2, 3]) { x++ }
        } catch (e) {
          threw = true;
        }
      }
      tryInc();
      export function test(): number { return threw ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("const x += 1 throws TypeError via compound assignment", async () => {
    const { result } = await compileAndRun(`
      var threw = false;
      function tryCmpd(): void {
        const x = 1;
        try {
          x += 1;
        } catch (e) {
          threw = true;
        }
      }
      tryCmpd();
      export function test(): number { return threw ? 1 : 0; }
    `);
    expect(result).toBe(1);
  });

  it("let assignment still works normally", async () => {
    const result = await runWasm(`
      export function test(): number {
        let x = 1;
        x = 2;
        x++;
        x += 10;
        return x; // 13
      }
    `);
    expect(result).toBe(13);
  });
});
