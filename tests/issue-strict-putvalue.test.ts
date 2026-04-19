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

describe("strict-mode PutValue on unresolvable destructuring target (§6.2.4 step 5)", () => {
  it("object destructuring shorthand throws in strict mode", async () => {
    const result = await run(`
      "use strict";
      export function main(): f64 {
        let threw: f64 = 0;
        try {
          ({ unresolvable } = { unresolvable: 1 });
        } catch (e) { threw = 1; }
        return threw;
      }
    `);
    expect(result).toBe(1);
  });

  it("object destructuring property-assignment form throws in strict mode", async () => {
    const result = await run(`
      "use strict";
      export function main(): f64 {
        let threw: f64 = 0;
        try {
          ({ x: unresolvable } = { x: 1 });
        } catch (e) { threw = 1; }
        return threw;
      }
    `);
    expect(result).toBe(1);
  });

  it("array destructuring element throws in strict mode", async () => {
    const result = await run(`
      "use strict";
      export function main(): f64 {
        let threw: f64 = 0;
        try {
          [unresolvable] = [1];
        } catch (e) { threw = 1; }
        return threw;
      }
    `);
    expect(result).toBe(1);
  });

  it("array destructuring rest element throws in strict mode", async () => {
    const result = await run(`
      "use strict";
      export function main(): f64 {
        let threw: f64 = 0;
        try {
          [...unresolvable] = [1, 2, 3];
        } catch (e) { threw = 1; }
        return threw;
      }
    `);
    expect(result).toBe(1);
  });

  it("does NOT throw when target is a declared variable", async () => {
    const result = await run(`
      "use strict";
      export function main(): f64 {
        let x: f64 = 0;
        [x] = [42];
        return x;
      }
    `);
    expect(result).toBe(42);
  });
});
