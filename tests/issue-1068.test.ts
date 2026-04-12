import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

function compileAndRun(source: string): any {
  const result = compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile error: ${result.errors?.map((e) => e.message).join("; ")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const mod = new WebAssembly.Module(result.binary);
  const instance = new WebAssembly.Instance(mod, imports);
  return (instance.exports as any).test();
}

describe("#1068 — await as label identifier in non-async contexts", () => {
  it("await: label in regular function should compile", () => {
    const result = compileAndRun(`
      function foo(): number {
        let sum = 0;
        await: for (let i = 0; i < 5; i++) {
          if (i === 3) break await;
          sum += i;
        }
        return sum;
      }
      export function test(): number { return foo(); }
    `);
    // 0 + 1 + 2 = 3
    expect(result).toBe(3);
  });

  it("await: label in regular function inside module should compile", () => {
    const result = compileAndRun(`
      function bar(): number {
        await: while (true) {
          break await;
        }
        return 99;
      }
      export function test(): number { return bar(); }
    `);
    expect(result).toBe(99);
  });
});
