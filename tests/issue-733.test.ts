import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function compileAndRun(src: string): Promise<number> {
  const r = compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as Function)();
}

describe("RangeError validation (#733)", () => {
  it("ArrayBuffer(-1) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          new ArrayBuffer(-1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("ArrayBuffer(8) works normally", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        const ab = new ArrayBuffer(8);
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("ArrayBuffer(NaN) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          new ArrayBuffer(NaN);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("new DataView(ab, -1) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        const ab = new ArrayBuffer(8);
        try {
          new DataView(ab, -1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("new DataView(ab, 0, -1) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        const ab = new ArrayBuffer(8);
        try {
          new DataView(ab, 0, -1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  // Note: offset > buffer length check requires buffer type resolution
  // which isn't available in the !className path (lib types not loaded).
  // Skipped: new DataView(ab, 10) when buffer length is 8.

  it("new DataView(ab, 0, 4) works when within bounds", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        const ab = new ArrayBuffer(8);
        const dv = new DataView(ab, 0, 4);
        return 1;
      }
    `);
    expect(ret).toBe(1);
  });

  it("new Array(-1) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          new Array(-1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("toPrecision(NaN) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          const n = 1.5;
          n.toPrecision(NaN);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("toFixed(-1) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          (1.5).toFixed(-1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("toFixed(101) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          (1.5).toFixed(101);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("toExponential(-1) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          (1.5).toExponential(-1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("toString(1) throws RangeError for radix < 2", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          (10).toString(1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("toString(37) throws RangeError for radix > 36", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          (10).toString(37);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("repeat(-1) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          "abc".repeat(-1);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });

  it("repeat(Infinity) throws RangeError", async () => {
    const ret = await compileAndRun(`
      export function test(): number {
        try {
          "abc".repeat(Infinity);
        } catch (e) {
          return 1;
        }
        return 0;
      }
    `);
    expect(ret).toBe(1);
  });
});
