import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(code: string): Promise<unknown> {
  const result = compile(code, { fileName: "test.ts" });
  if (!result.success) throw new Error(`CE: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).main();
}

describe("#1016a — class method param array destructuring defaults", () => {
  it("fires default when array element is missing (exhausted iterator)", { timeout: 30000 }, async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([]); }
    `);
    expect(result).toBe(23);
  });

  it("does NOT fire default when array element is present", async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([42]); }
    `);
    expect(result).toBe(42);
  });

  it("fires default for second element when array has only one", async () => {
    const result = await run(`
      class C {
        method([a, b = 99]: any) { return b; }
      }
      export function main(): f64 { return new C().method([1]); }
    `);
    expect(result).toBe(99);
  });

  it("does NOT fire default for null array element (null !== undefined)", async () => {
    const result = await run(`
      class C {
        method([x = 23]: any) { return x; }
      }
      export function main(): f64 { return new C().method([null]) ? 1 : 0; }
    `);
    // null is not undefined, so default should NOT fire; x should be null (falsy → 0)
    expect(result).toBe(0);
  });
});
