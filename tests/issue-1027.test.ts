import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const importResult = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  if (typeof importResult.setExports === "function") {
    importResult.setExports(instance.exports as any);
  }
  return (instance.exports as any).test?.();
}

describe("Object.defineProperties accessor descriptors (#1027)", () => {
  it("defineProperties with inline get method shorthand compiles and runs", async () => {
    const r = await run(`
      const obj: any = {};
      Object.defineProperties(obj, {
        x: { get() { return 42; } },
      });
      export function test() { return obj.x === 42 ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("defineProperties with multiple accessor descriptors compiles and runs", async () => {
    const r = await run(`
      const o: any = {};
      Object.defineProperties(o, {
        done: { get() { return true; } },
        value: { get() { return "v"; } },
      });
      export function test() { return o.done === true && o.value === "v" ? 1 : 0; }
    `);
    expect(r).toBe(1);
  });

  it("defineProperties with setter descriptor at least compiles (no 'Missing __make_getter_callback import' CE)", async () => {
    const r = compile(
      `
        const obj: any = {};
        let stored: any = 0;
        Object.defineProperties(obj, {
          v: { set(value: any) { stored = value; }, configurable: true },
        });
        export function test() { return 1; }
      `,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });

  it("defineProperties with identifier-referenced setter at least compiles", async () => {
    const r = compile(
      `
        const obj: any = {};
        let slot: any = 0;
        const setFun = function (value: any) { slot = value; };
        Object.defineProperties(obj, {
          prop: { set: setFun, enumerable: true, configurable: true },
        });
        export function test() { return 1; }
      `,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(true);
  });
});
