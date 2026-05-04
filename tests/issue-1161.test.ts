import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1161 — destructure null/undefined in class method params", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test?.();
  }

  it("private method via getter — iterable does not spuriously throw 'Cannot destructure'", async () => {
    // Previously: `Cannot destructure 'null' or 'undefined' [in C___priv_method()]`
    //   thrown from the tuple-from-externref coercion at the call site because
    //   no known vec type matched and the else branch returned ref.null,
    //   which then tripped the in-callee null guard before the iterator ran.
    // Now: buildTupleFromExternref falls back to `__array_from_iter`
    //   materialization so iterables flow through to destructure.
    // Matches language/expressions/class/dstr/private-meth-ary-init-iter-close.js.
    const ret = await run(`
      export function test(): number {
        const iter: any = {};
        iter[Symbol.iterator] = function() {
          return {
            next: function() {
              return { value: null, done: false };
            }
          };
        };

        const C = class {
          #method([x]) {}
          get method(): any { return this.#method; }
        };

        try {
          new C().method(iter);
          return 1;
        } catch (e) {
          return 0;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("public method with null arg still throws TypeError per spec (RequireObjectCoercible)", async () => {
    const ret = await run(`
      export function test(): number {
        class C {
          method([x]) {}
        }

        let threw = 0;
        try {
          new C().method(null as any);
        } catch (e) {
          threw = 1;
        }
        return threw;
      }
    `);
    expect(ret).toBe(1);
  });

  it("public method with undefined arg throws TypeError per spec", async () => {
    const ret = await run(`
      export function test(): number {
        class C {
          method([x]) {}
        }

        let threw = 0;
        try {
          new C().method(undefined as any);
        } catch (e) {
          threw = 1;
        }
        return threw;
      }
    `);
    expect(ret).toBe(1);
  });
});
