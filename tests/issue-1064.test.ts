import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1064 — DataView bridge: subview bounds propagate RangeError", () => {
  async function runTest(src: string): Promise<{ pass: boolean; ret?: unknown; error?: string }> {
    const result = compile(src, { skipSemanticDiagnostics: true });
    if (!result.success) return { pass: false, error: result.errors?.[0]?.message };
    const importObj = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
    if (typeof (importObj as any).setExports === "function") {
      (importObj as any).setExports(instance.exports);
    }
    try {
      const ret = (instance.exports as any).test();
      return { pass: ret === 1, ret };
    } catch (e: any) {
      return { pass: false, error: String(e) };
    }
  }

  it("getUint16 on subview with byteOffset throws RangeError out of window", async () => {
    const src = `
      export function test(): number {
        const buffer: ArrayBuffer = new ArrayBuffer(12);
        const sample = new DataView(buffer, 10);
        let threw: number = 0;
        try { (sample as any).getUint16(1); } catch (e) { threw = 1; }
        return threw;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("getUint16 on subview with byteOffset + byteLength throws RangeError out of window", async () => {
    const src = `
      export function test(): number {
        const buffer: ArrayBuffer = new ArrayBuffer(12);
        const sample = new DataView(buffer, 0, 2);
        let threw: number = 0;
        try { (sample as any).getUint16(1); } catch (e) { threw = 1; }
        return threw;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("getInt32 full-buffer out-of-range still throws (baseline)", async () => {
    const src = `
      export function test(): number {
        const buffer: ArrayBuffer = new ArrayBuffer(12);
        const sample = new DataView(buffer, 0);
        let threw: number = 0;
        try { (sample as any).getInt32(9); } catch (e) { threw = 1; }
        return threw;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("getUint16 inside subview window returns value (happy path)", async () => {
    const src = `
      export function test(): number {
        const buffer: ArrayBuffer = new ArrayBuffer(12);
        const setter = new DataView(buffer, 0);
        (setter as any).setUint8(4, 0x12);
        (setter as any).setUint8(5, 0x34);
        const sample = new DataView(buffer, 4, 4);
        const v: number = (sample as any).getUint16(0);
        return v === 0x1234 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("reassigning DataView on same buffer updates the view window", async () => {
    const src = `
      export function test(): number {
        const buffer: ArrayBuffer = new ArrayBuffer(12);
        let sample = new DataView(buffer, 0);
        let threw1: number = 0;
        try { (sample as any).getUint16(11); } catch (e) { threw1 = 1; }
        sample = new DataView(buffer, 10);
        let threw2: number = 0;
        try { (sample as any).getUint16(1); } catch (e) { threw2 = 1; }
        return threw1 === 1 && threw2 === 1 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });

  it("setUint8 out-of-range on subview does not write partial bytes", async () => {
    const src = `
      export function test(): number {
        const buffer: ArrayBuffer = new ArrayBuffer(4);
        const sample = new DataView(buffer, 2, 1);
        let threw: number = 0;
        try { (sample as any).setUint8(1, 39); } catch (e) { threw = 1; }
        const probe = new DataView(buffer, 0);
        const b0: number = (probe as any).getUint8(0);
        const b1: number = (probe as any).getUint8(1);
        const b2: number = (probe as any).getUint8(2);
        const b3: number = (probe as any).getUint8(3);
        return threw === 1 && b0 === 0 && b1 === 0 && b2 === 0 && b3 === 0 ? 1 : 0;
      }
    `;
    const { pass, error } = await runTest(src);
    expect(error).toBeUndefined();
    expect(pass).toBe(true);
  });
});
