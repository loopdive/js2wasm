import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("dstr null/undefined RequireObjectCoercible", () => {
  async function run(src: string): Promise<any> {
    const r = compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test?.();
  }

  it("object destructure with binding from null literal throws TypeError", async () => {
    const ret = await run(`
      export function test(): number {
        try {
          const { a } = (null as any);
          return 0;
        } catch (e: any) {
          return 1;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("object destructure with binding from undefined literal throws TypeError", async () => {
    const ret = await run(`
      export function test(): number {
        try {
          const { a } = (undefined as any);
          return 0;
        } catch (e: any) {
          return 1;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("empty object pattern from null does NOT throw (no property accesses)", async () => {
    const ret = await run(`
      export function test(): number {
        try {
          const {} = (null as any);
          return 42;
        } catch (e: any) {
          return 1;
        }
      }
    `);
    expect(ret).toBe(42);
  });

  it("array destructure from null throws TypeError", async () => {
    const ret = await run(`
      export function test(): number {
        try {
          const [a] = (null as any);
          return 0;
        } catch (e: any) {
          return 1;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("object destructure assignment from null throws TypeError", async () => {
    const ret = await run(`
      export function test(): number {
        let x: any;
        try {
          ({ x } = (null as any));
          return 0;
        } catch (e: any) {
          return 1;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("function param default null triggers throw when no arg passed", async () => {
    const ret = await run(`
      function f({}: any = null as any): number { return 0; }
      export function test(): number {
        try {
          return f();
        } catch (e: any) {
          return 1;
        }
      }
    `);
    expect(ret).toBe(1);
  });

  it("regular destructure with value present still works", async () => {
    const ret = await run(`
      export function test(): number {
        const obj = { x: 42 };
        const { x } = obj;
        return x;
      }
    `);
    expect(ret).toBe(42);
  });
});
