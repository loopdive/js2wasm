import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(code: string): Promise<number> {
  const r = compile(code, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as any).test() as number;
}

describe("#965 — Static method null access on Object/Symbol/ArrayBuffer/Proxy", () => {
  it("Object.hasOwn on inherited property returns false", async () => {
    // Uses Object.create() which returns a real JS object via host
    const result = await run(`
      export function test(): number {
        const base: any = {foo: 42};
        const o: any = Object.create(base);
        return Object.hasOwn(o, "foo") ? 1 : 0;
      }
    `);
    expect(result).toBe(0); // inherited, not own
  });

  it("Object.is(NaN, NaN) returns true", async () => {
    const result = await run(`
      export function test(): number {
        return Object.is(NaN, NaN) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.is(+0, -0) returns false", async () => {
    const result = await run(`
      export function test(): number {
        return Object.is(0, -0) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  it("Object.is(false, 0) returns false (boolean vs number)", async () => {
    const result = await run(`
      export function test(): number {
        return Object.is(false, 0) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });

  it("Object.is(true, true) returns true", async () => {
    const result = await run(`
      export function test(): number {
        return Object.is(true, true) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.is(1, 1) returns true", async () => {
    const result = await run(`
      export function test(): number {
        return Object.is(1, 1) ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Object.assign merges properties", async () => {
    const result = await run(`
      export function test(): number {
        const target: any = Object.create(null);
        (target as any).a = 1;
        const src: any = Object.create(null);
        (src as any).b = 2;
        Object.assign(target, src);
        return (target as any).b === 2 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("Symbol.for returns consistent symbol", async () => {
    const result = await run(`
      export function test(): number {
        const s1 = Symbol.for('test-965');
        const s2 = Symbol.for('test-965');
        return s1 === s2 ? 1 : 0;
      }
    `);
    expect(result).toBe(1);
  });

  it("ArrayBuffer.isView returns false for non-view", async () => {
    const result = await run(`
      export function test(): number {
        const buf = new ArrayBuffer(4);
        return ArrayBuffer.isView(buf) ? 1 : 0;
      }
    `);
    expect(result).toBe(0); // ArrayBuffer itself is not a view
  });

  it("Object.is boolean discrimination vs number", async () => {
    // Object.is(true, 1) should return false — booleans and numbers are different types
    const result = await run(`
      export function test(): number {
        return Object.is(true, 1) ? 1 : 0;
      }
    `);
    expect(result).toBe(0);
  });
});
