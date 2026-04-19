import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("static method `this.#priv` no longer traps", () => {
  it("this.#getter in a static method returns the static private value", async () => {
    const ret = await run(`
      var C = class {
        static get #f(): string { return 'Test262'; }
        static access(): string { return this.#f; }
      };
      export function test(): f64 {
        return C.access() === 'Test262' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("this.#field in a static method returns the static private field", async () => {
    const ret = await run(`
      var C = class {
        static #f: f64 = 42;
        static access(): f64 { return this.#f; }
      };
      export function test(): f64 {
        return C.access() === 42 ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("this.#method accessed as value in static method does not trap", async () => {
    const ret = await run(`
      var C = class {
        static #helper(): f64 { return 7; }
        static access(): f64 {
          let fn = this.#helper;
          return 1;
        }
      };
      export function test(): f64 {
        return C.access();
      }
    `);
    expect(ret).toBe(1);
  });
});
