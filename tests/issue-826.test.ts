import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("Issue #826 — illegal cast", () => {
  it("private field access from inner arrow with wrong this", async () => {
    const result = await run(`
export function test(): f64 {
  var C = class {
    #f = 'Test262';
    method() {
      let arrowFunction = () => { return this.#f; };
      return arrowFunction();
    }
  };
  var c = new C();
  var o = {};
  try { c.method.call(o); return 0; } catch(e) { return 1; }
}
`);
    expect(result).toBe(1);
  });

  it("var f: any; f = arrow; f() does not trap", async () => {
    const result = await run(`
export function test(): f64 {
  var f: any;
  f = () => 42;
  return f() === 42 ? 1 : 0;
}
`);
    expect(result).toBe(1);
  });

  it("arguments object in shadowed scope", async () => {
    // This tests the fixLocalSetCoercion for externref → ref_null
    const result = await run(`
export function test(): f64 {
  function testcase() {
    var args = arguments;
    return args.length === 0 ? 1 : 0;
  }
  return testcase();
}
`);
    expect(result).toBe(1);
  });

  it("normal method call still works", async () => {
    const result = await run(`
export function test(): f64 {
  var C = class {
    #f = 42;
    method() {
      let inner = () => this.#f;
      return inner();
    }
  };
  var c = new C();
  return c.method() === 42 ? 1 : 0;
}
`);
    expect(result).toBe(1);
  });
});
