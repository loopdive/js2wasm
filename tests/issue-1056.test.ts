import { describe, test, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const result = compile(src, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => e.message).join("\n"));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1056 DataView set/get methods", () => {
  test("setUint8 + getUint8 round-trip", async () => {
    expect(
      await run(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const dv = new DataView(buffer, 0);
          dv.setUint8(0, 127);
          return dv.getUint8(0);
        }
      `),
    ).toBe(127);
  });

  test("setUint16 + getUint16 big-endian", async () => {
    expect(
      await run(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const dv = new DataView(buffer, 0);
          dv.setUint8(0, 127);
          dv.setUint8(1, 255);
          return dv.getUint16(0, false);
        }
      `),
    ).toBe(32767);
  });

  test("setUint16 + getUint16 little-endian", async () => {
    expect(
      await run(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const dv = new DataView(buffer, 0);
          dv.setUint8(0, 0x34);
          dv.setUint8(1, 0x12);
          return dv.getUint16(0, true);
        }
      `),
    ).toBe(0x1234);
  });

  test("setInt32 + getInt32", async () => {
    expect(
      await run(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const dv = new DataView(buffer, 0);
          dv.setInt32(0, -1, false);
          return dv.getInt32(0, false);
        }
      `),
    ).toBe(-1);
  });

  test("setFloat32 + getFloat32", async () => {
    expect(
      await run(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const dv = new DataView(buffer, 0);
          dv.setFloat32(0, 1.5, true);
          return dv.getFloat32(0, true);
        }
      `),
    ).toBeCloseTo(1.5);
  });

  test("setFloat64 + getFloat64", async () => {
    expect(
      await run(`
        export function test(): number {
          const buffer = new ArrayBuffer(8);
          const dv = new DataView(buffer, 0);
          dv.setFloat64(0, 3.14159, true);
          return dv.getFloat64(0, true);
        }
      `),
    ).toBeCloseTo(3.14159);
  });
});
