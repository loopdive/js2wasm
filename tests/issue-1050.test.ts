import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as any);
  if (typeof (imports as any).setExports === "function") {
    (imports as any).setExports(instance.exports);
  }
  return (instance.exports as any).test();
}

describe("#1050 typeof UndeclaredIdentifier returns 'undefined'", () => {
  it("typeof undeclared identifier resolves to 'undefined' at compile time", async () => {
    const v = await run(`
      export function test(): number {
        if (typeof (f as any) === "undefined") return 1;
        return 2;
      }
    `);
    expect(v).toBe(1);
  });

  it("typeof undeclared identifier with !== comparison", async () => {
    const v = await run(`
      export function test(): number {
        if (typeof (f as any) !== "undefined") return 3;
        return 1;
      }
    `);
    expect(v).toBe(1);
  });

  it("typeof undeclared identifier does not throw at runtime", async () => {
    const v = await run(`
      export function test(): number {
        try {
          var t = typeof (f as any);
          if (t === "undefined") return 1;
          return 2;
        } catch (e) {
          return 3;
        }
      }
    `);
    expect(v).toBe(1);
  });

  it("bare reference to undeclared identifier still throws (non-regression)", async () => {
    const v = await run(`
      export function test(): number {
        try { (f as any); return 2; }
        catch (e) { return 1; }
      }
    `);
    expect(v).toBe(1);
  });
});
