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

describe("function parameter destructuring with nested rest-in-rest", () => {
  it("standalone function [...[...x]] param extracts inner rest as vec", async () => {
    const src = `
      function f([...[...x]]: number[]): number {
        return x.length === 3 && x[0] === 1 && x[2] === 3 ? 1 : 0;
      }
      export function test(): f64 {
        return f([1, 2, 3]);
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });

  it("module-scope class method [...[...x]] param extracts inner rest as vec", async () => {
    const src = `
      class C {
        m([...[...x]]: number[]): number {
          return x.length === 3 ? 1 : 0;
        }
      }
      export function test(): f64 {
        return new C().m([1, 2, 3]);
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });

  it("object literal method [...[...x]] param extracts inner rest as vec", async () => {
    const src = `
      export function test(): f64 {
        const obj = {
          m([...[...x]]: number[]): number {
            return x.length === 3 && x[0] === 1 && x[2] === 3 ? 1 : 0;
          }
        };
        return obj.m([1, 2, 3]);
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });

  it("standalone function single rest [...x] still works (regression guard)", async () => {
    const src = `
      function f([...x]: number[]): number {
        return x.length === 3 && x[0] === 1 && x[2] === 3 ? 1 : 0;
      }
      export function test(): f64 {
        return f([1, 2, 3]);
      }
    `;
    const { ret, threw } = await run(src);
    expect(threw).toBe(false);
    expect(ret).toBe(1);
  });
});
