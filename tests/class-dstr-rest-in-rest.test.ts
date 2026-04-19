import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<{ ret: number; threw: boolean; message?: string }> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  try {
    const ret = (instance.exports as any).test();
    return { ret, threw: false };
  } catch (e: any) {
    return { ret: -1, threw: true, message: e?.message };
  }
}

describe("for-of destructuring with nested rest-in-rest", () => {
  it("for (const [...[...x]] of [values]) extracts inner rest as vec", async () => {
    const src = `
      export function test(): f64 {
        const values: number[] = [1, 2, 3];
        const arr: number[][] = [values];
        let ok = 0;
        for (const [...[...x]] of arr) {
          if (x.length !== 3) return 10;
          if (x[0] !== 1) return 11;
          if (x[1] !== 2) return 12;
          if (x[2] !== 3) return 13;
          ok = 1;
        }
        return ok;
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });

  it("for (let [...[...x]] of ...) with let binding", async () => {
    const src = `
      export function test(): f64 {
        const values: number[] = [10, 20];
        const arr: number[][] = [values];
        let sum = 0;
        for (let [...[...x]] of arr) {
          sum = x[0] + x[1];
        }
        return sum === 30 ? 1 : sum;
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });

  it("top-level const [...[...x]] = values (unchanged — already worked)", async () => {
    const src = `
      export function test(): f64 {
        const values: number[] = [1, 2, 3];
        const [...[...x]] = values;
        return x.length === 3 && x[0] === 1 && x[2] === 3 ? 1 : 0;
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });

  it("single rest in for-of still works (regression guard)", async () => {
    const src = `
      export function test(): f64 {
        const values: number[] = [1, 2, 3];
        let sum = 0;
        for (const [...x] of [values]) {
          sum += x[0] + x[1] + x[2];
        }
        return sum === 6 ? 1 : 0;
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });
});
