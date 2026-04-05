import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function assertValidWasm(source: string): Promise<void> {
  const r = compile(source, { fileName: "test.ts" });
  expect(r.success).toBe(true);
  const imp = buildImports(r.imports!, undefined, r.stringPool);
  await expect(WebAssembly.instantiate(r.binary!, imp)).resolves.toBeDefined();
}

async function runTest(source: string): Promise<number> {
  const r = compile(source, { fileName: "test.ts" });
  expect(r.success).toBe(true);
  const imp = buildImports(r.imports!, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary!, imp);
  return (instance.exports as any).test();
}

describe("#966 — static private fields + Promise arity", () => {
  describe("Pattern 1: static private field via 'this' in static method", () => {
    it("this.#x in static method reads the correct global value", async () => {
      // Previously: extern.convert_any[0] expected type anyref, found call of type externref
      const result = await runTest(`
export function test(): number {
  class C {
    static #x = 42;
    static getX(): number { return this.#x; }
  }
  return C.getX();
}`);
      expect(result).toBe(42);
    });

    it("this.#m (closure field) in static method produces valid Wasm", async () => {
      await assertValidWasm(`
export function test(): number {
  class C {
    static #m = (): string => 'outer class';
    static fieldAccess(): string { return this.#m(); }
  }
  return 1;
}`);
    });

    it("static field still accessible via ClassName.#field (regression guard)", async () => {
      const result = await runTest(`
export function test(): number {
  class C {
    static #x = 10;
    static getX(): number { return C.#x; }
  }
  return C.getX();
}`);
      expect(result).toBe(10);
    });

    it("this.staticProp in static method reads correct global (public field)", async () => {
      const result = await runTest(`
export function test(): number {
  class C {
    static value = 7;
    static get(): number { return this.value; }
  }
  return C.get();
}`);
      expect(result).toBe(7);
    });
  });

  describe("Pattern 2: Promise.then arity mismatch", () => {
    it("Promise_then registered as builtin (2-param) when Error triggers lib scan", () => {
      // When source uses 'Error', lib files are scanned for extern classes.
      // TypeScript's Promise interface declares then(onfulfilled?, onrejected?) → 3 Wasm params.
      // Previously this caused Promise_then to be pre-registered with 3 params, but the
      // Promise-specific codegen handler pushed only 2 values → "need 3, got 2" invalid Wasm.
      const src = `
function $DONE(err?: any): void {}
export function test(): number {
  const error = new Error();
  async function* gen() { yield 1; }
  const iter = gen();
  iter.next().then(() => {}).catch((e: any) => {
    iter.next().then((x: any) => {}).then($DONE, $DONE);
  });
  return 1;
}`;
      const r = compile(src, { fileName: "test.ts" });
      expect(r.success).toBe(true);
      const promiseThen = r.imports!.find((i) => i.name === "Promise_then");
      // Must be builtin (2-param), not extern_class (3-param)
      expect(promiseThen?.intent?.type).toBe("builtin");
    });

    it("1-arg .then() with Error in scope produces valid Wasm", async () => {
      await assertValidWasm(`
const error = new Error();
export function test(): number {
  async function* gen() { yield 1; }
  const iter = gen();
  iter.next().then((x: any) => x);
  return 1;
}`);
    });

    it("2-arg .then(cb1, cb2) with named function args produces valid Wasm", async () => {
      await assertValidWasm(`
function $DONE(err?: any): void {}
export function test(): number {
  async function* gen() { yield 1; }
  const iter = gen();
  iter.next().then((x: any) => {}).then($DONE, $DONE);
  return 1;
}`);
    });

    it(".catch() callback with chained .then($DONE, $DONE) produces valid Wasm", async () => {
      // Exact pattern from yield-promise-reject-next-catch.js
      await assertValidWasm(`
function $DONE(err?: any): void {}
export function test(): number {
  const error = new Error();
  async function* gen() { yield Promise.reject(error); }
  const iter = gen();
  iter.next().then(() => { throw new Error("wrong"); }).catch((rejectValue: any) => {
    iter.next().then(({done, value}: any) => {}).then($DONE, $DONE);
  });
  return 1;
}`);
    });
  });
});
