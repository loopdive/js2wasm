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

describe("#850 -- Object-to-primitive conversion", () => {
  it("Number coercion of opaque objects returns NaN not crash", async () => {
    // +obj where obj has no valueOf/toString accessible from JS
    // should return NaN, not throw "Cannot convert object to primitive value"
    const result = await runWasm(`
      export function test(): number {
        const obj: any = {};
        const x = +obj;
        // x should be NaN (since {} has no accessible valueOf)
        if (x !== x) return 1; // NaN check
        return 0;
      }
    `);
    expect(result).toBe(1); // NaN
  });

  it("function + number does not throw", async () => {
    const result = await runWasm(`
      export function test(): number {
        const f: any = function() { return 0; };
        const x: any = f + 1;
        return typeof x === "number" ? 1 : (typeof x === "string" ? 2 : 0);
      }
    `);
    // Should not throw - either NaN+1=NaN (number) or string concat
    expect([1, 2]).toContain(result);
  });

  it("__extern_toString on opaque struct does not throw", async () => {
    const result = await runWasm(`
      export function test(): number {
        const obj: any = {};
        const s: any = "" + obj;
        return typeof s === "string" ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });
});
