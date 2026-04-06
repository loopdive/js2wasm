import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function runTS(src: string): Promise<any> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test();
}

describe("issue-848 class computed property names and accessors", () => {
  it("class declaration: string literal accessor on prototype", async () => {
    // C.prototype['default'] should invoke the instance getter
    const ret = await runTS(`
      class C {
        get 'default'(): string { return 'get string'; }
        set 'default'(param: string) {}
      }
      export function test(): number {
        return C.prototype['default'] === 'get string' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class declaration: numeric accessor on prototype (binary literal)", async () => {
    // C.prototype['2'] should invoke getter for 0b10 property
    const ret = await runTS(`
      class C {
        get 0b10(): string { return 'get string'; }
        set 0b10(param: string) {}
      }
      export function test(): number {
        return C.prototype['2'] === 'get string' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class declaration: computed key (string concat) on prototype", async () => {
    // Computed key 'str' + 'ing' = 'string'
    const ret = await runTS(`
      let _: string;
      class C {
        get ['str' + 'ing'](): string { return 'get string'; }
        set ['str' + 'ing'](param: string) {}
      }
      export function test(): number {
        return C.prototype['string'] === 'get string' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class expression: string literal accessor on prototype", async () => {
    // var C = class { get 'default'() ... } — class expression
    const ret = await runTS(`
      var C = class {
        get 'default'(): string { return 'get string'; }
        set 'default'(param: string) {}
      };
      export function test(): number {
        return C.prototype['default'] === 'get string' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class expression: static accessor via ClassName[key]", async () => {
    // C['default'] should invoke the static getter
    const ret = await runTS(`
      var C = class {
        static get 'default'(): string { return 'get static'; }
        static set 'default'(param: string) {}
      };
      export function test(): number {
        return C['default'] === 'get static' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class declaration: static accessor via ClassName[key]", async () => {
    const ret = await runTS(`
      class C {
        static get 'myProp'(): string { return 'static get'; }
        static set 'myProp'(v: string) {}
      }
      export function test(): number {
        return C['myProp'] === 'static get' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class declaration: empty string property name accessor", async () => {
    const ret = await runTS(`
      class C {
        get ''(): string { return 'empty key'; }
        set ''(v: string) {}
      }
      export function test(): number {
        return C.prototype[''] === 'empty key' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class declaration: setter side-effect via prototype bracket assignment", async () => {
    // C.prototype['key'] = value should invoke the setter
    const ret = await runTS(`
      let captured: string = '';
      class C {
        get 'key'(): string { return captured; }
        set 'key'(v: string) { captured = v; }
      }
      export function test(): number {
        C.prototype['key'] = 'hello';
        return captured === 'hello' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("class declaration: static setter side-effect via ClassName[key] assignment", async () => {
    const ret = await runTS(`
      let captured: string = '';
      class C {
        static get 'key'(): string { return captured; }
        static set 'key'(v: string) { captured = v; }
      }
      export function test(): number {
        C['key'] = 'world';
        return captured === 'world' ? 1 : 0;
      }
    `);
    expect(ret).toBe(1);
  });
});
