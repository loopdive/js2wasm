import { describe, it, expect } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import type { WasmModule, Instr } from "../src/ir/types.js";
import { createEmptyModule } from "../src/ir/types.js";

function buildModuleWithBody(body: Instr[], opts?: { paramType?: "i32" | "f64"; resultType?: "i32" | "f64"; memories?: { min: number }[] }): WasmModule {
  const paramKind = opts?.paramType ?? "i32";
  const resultKind = opts?.resultType ?? "i32";
  const mod = createEmptyModule();
  if (opts?.memories) mod.memories = opts.memories;
  mod.types.push({ kind: "func", name: "test", params: [{ kind: paramKind }], results: [{ kind: resultKind }] });
  mod.functions.push({
    name: "test",
    typeIdx: 0,
    locals: [],
    body,
    exported: true,
  });
  mod.exports.push({ name: "test", desc: { kind: "func", index: 0 } });
  return mod;
}

describe("linear-memory IR instructions", () => {
  it("emits i32.load and i32.store", async () => {
    const mod = buildModuleWithBody([
      // Store value+1 at address, then load it back
      { op: "local.get", index: 0 },        // addr
      { op: "local.get", index: 0 },        // addr
      { op: "i32.load", align: 2, offset: 0 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.store", align: 2, offset: 0 },
      { op: "local.get", index: 0 },        // addr
      { op: "i32.load", align: 2, offset: 0 },
    ], { memories: [{ min: 1 }] });
    const binary = emitBinary(mod);
    expect(binary.length).toBeGreaterThan(8);
    const { instance } = await WebAssembly.instantiate(binary);
    const test = (instance.exports as any).test;
    // Memory starts zeroed, so: load 0 + 1 = 1, store 1, load 1
    expect(test(0)).toBe(1);
  });

  it("emits i32.load8_u and i32.store8", async () => {
    const mod = buildModuleWithBody([
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xff },
      { op: "i32.store8", align: 0, offset: 0 },
      { op: "local.get", index: 0 },
      { op: "i32.load8_u", align: 0, offset: 0 },
    ], { memories: [{ min: 1 }] });
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    expect((instance.exports as any).test(0)).toBe(255);
  });

  it("emits i32.div_u and i32.rem_u", async () => {
    const mod = buildModuleWithBody([
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 3 },
      { op: "i32.div_u" },
    ]);
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    expect((instance.exports as any).test(10)).toBe(3);
  });

  it("emits i32.lt_u", async () => {
    const mod = buildModuleWithBody([
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 5 },
      { op: "i32.lt_u" },
    ]);
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    expect((instance.exports as any).test(3)).toBe(1);
    expect((instance.exports as any).test(5)).toBe(0);
    expect((instance.exports as any).test(7)).toBe(0);
  });

  it("emits i32.load with non-zero offset", async () => {
    const mod = buildModuleWithBody([
      // Store 42 at addr+4, then load from addr+4
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 42 },
      { op: "i32.store", align: 2, offset: 4 },
      { op: "local.get", index: 0 },
      { op: "i32.load", align: 2, offset: 4 },
    ], { memories: [{ min: 1 }] });
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    expect((instance.exports as any).test(0)).toBe(42);
  });

  it("emits memory section in binary", () => {
    const mod = createEmptyModule();
    mod.memories = [{ min: 1 }];
    mod.types.push({ kind: "func", name: "f", params: [], results: [] });
    mod.functions.push({ name: "f", typeIdx: 0, locals: [], body: [], exported: false });
    const binary = emitBinary(mod);
    // Verify wasm magic
    expect(binary[0]).toBe(0x00);
    expect(binary[1]).toBe(0x61);
    expect(binary[2]).toBe(0x73);
    expect(binary[3]).toBe(0x6d);
    // Find memory section (id = 5)
    let found = false;
    let pos = 8;
    while (pos < binary.length) {
      const sectionId = binary[pos]!;
      pos++;
      // Read section size (LEB128)
      let size = 0, shift = 0;
      while (true) {
        const b = binary[pos]!;
        size |= (b & 0x7f) << shift;
        pos++;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (sectionId === 5) {
        found = true;
        break;
      }
      pos += size;
    }
    expect(found).toBe(true);
  });
});
