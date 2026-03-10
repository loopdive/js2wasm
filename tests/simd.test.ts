import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { WasmEncoder } from "../src/emit/encoder.js";
import { OP, SIMD, TYPE } from "../src/emit/opcodes.js";
import {
  addRuntime,
  addUint8ArrayRuntime,
  addArrayRuntime,
  addStringRuntime,
} from "../src/codegen-linear/runtime.js";
import { addSimdRuntime } from "../src/codegen-linear/simd.js";
import type { Instr, ValType } from "../src/ir/types.js";

// ---- Encoder / Opcode unit tests ----

describe("SIMD opcodes", () => {
  it("SIMD prefix is 0xFD", () => {
    expect(OP.simd_prefix).toBe(0xfd);
  });

  it("v128 type is 0x7B", () => {
    expect(TYPE.v128).toBe(0x7b);
  });

  it("key SIMD opcodes have correct values", () => {
    expect(SIMD.v128_const).toBe(0x0c);
    expect(SIMD.v128_load).toBe(0x00);
    expect(SIMD.v128_store).toBe(0x0b);
    expect(SIMD.i8x16_splat).toBe(0x0f);
    expect(SIMD.i16x8_splat).toBe(0x10);
    expect(SIMD.i32x4_splat).toBe(0x11);
    expect(SIMD.f64x2_splat).toBe(0x14);
    expect(SIMD.i8x16_eq).toBe(0x23);
    expect(SIMD.i16x8_eq).toBe(0x2d);
    expect(SIMD.i32x4_eq).toBe(0x37);
    expect(SIMD.f64x2_eq).toBe(0x47);
    expect(SIMD.v128_any_true).toBe(0x53);
    expect(SIMD.i8x16_all_true).toBe(0x63);
    expect(SIMD.i8x16_bitmask).toBe(0x64);
    expect(SIMD.i16x8_bitmask).toBe(0x84);
    expect(SIMD.i32x4_bitmask).toBe(0xa4);
    expect(SIMD.i16x8_add).toBe(0x8e);
    expect(SIMD.i32x4_add).toBe(0xae);
    expect(SIMD.f64x2_add).toBe(0xf0);
    expect(SIMD.f64x2_mul).toBe(0xf2);
  });
});

describe("WasmEncoder v128", () => {
  it("encodes 16 bytes for v128", () => {
    const enc = new WasmEncoder();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    enc.v128(bytes);
    expect(enc.finish()).toEqual(bytes);
  });

  it("throws if v128 bytes is not exactly 16", () => {
    const enc = new WasmEncoder();
    expect(() => enc.v128(new Uint8Array(15))).toThrow("v128 must be exactly 16 bytes");
    expect(() => enc.v128(new Uint8Array(17))).toThrow("v128 must be exactly 16 bytes");
  });
});

// ---- Binary emitter tests for SIMD instructions ----

describe("SIMD binary emission", () => {
  it("emits v128.const correctly", () => {
    const mod = createEmptyModule();
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$test_type",
      params: [],
      results: [{ kind: "v128" }],
    });
    const bytes = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    mod.functions.push({
      name: "test_v128_const",
      typeIdx,
      locals: [],
      body: [{ op: "v128.const", bytes }],
      exported: true,
    });
    mod.exports.push({ name: "test_v128_const", desc: { kind: "func", index: 0 } });
    // Should not throw during emission
    const binary = emitBinary(mod);
    expect(binary).toBeInstanceOf(Uint8Array);
    expect(binary.length).toBeGreaterThan(0);
  });

  it("emits i32x4.splat + i32x4.extract_lane correctly", () => {
    const mod = createEmptyModule();
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$test_type",
      params: [{ kind: "i32" }],
      results: [{ kind: "i32" }],
    });
    mod.functions.push({
      name: "test_splat_extract",
      typeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "i32x4.splat" },
        { op: "i32x4.extract_lane", lane: 2 },
      ],
      exported: true,
    });
    mod.exports.push({ name: "test_splat_extract", desc: { kind: "func", index: 0 } });
    const binary = emitBinary(mod);
    expect(binary).toBeInstanceOf(Uint8Array);
  });

  it("emits v128.load and v128.store correctly", () => {
    const mod = createEmptyModule();
    mod.memories.push({ min: 1 });
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$test_type",
      params: [],
      results: [],
    });
    mod.functions.push({
      name: "test_load_store",
      typeIdx,
      locals: [{ name: "v", type: { kind: "v128" } }],
      body: [
        // Load v128 from address 0
        { op: "i32.const", value: 0 },
        { op: "v128.load", align: 4, offset: 0 },
        { op: "local.set", index: 0 },
        // Store it back at address 16
        { op: "i32.const", value: 16 },
        { op: "local.get", index: 0 },
        { op: "v128.store", align: 4, offset: 0 },
      ],
      exported: true,
    });
    mod.exports.push({ name: "test_load_store", desc: { kind: "func", index: 0 } });
    const binary = emitBinary(mod);
    expect(binary).toBeInstanceOf(Uint8Array);
  });
});

// ---- SIMD runtime e2e tests (linear memory) ----

async function buildWithSimd(
  setup: (mod: ReturnType<typeof createEmptyModule>, fi: Record<string, number>) => void,
) {
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addSimdRuntime(mod);

  const fi: Record<string, number> = {};
  for (let i = 0; i < mod.functions.length; i++) {
    fi[mod.functions[i].name] = i;
  }

  setup(mod, fi);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports as Record<string, Function>;
}

describe("SIMD string equality (__str_eq_simd)", () => {
  it("returns 1 for equal strings", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$test_type",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      // Create two identical strings "helloworld12345!" (16 bytes — exact SIMD chunk)
      const str = "helloworld12345!";
      const strBytes = new TextEncoder().encode(str);
      mod.functions.push({
        name: "test_str_eq",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
        ],
        body: [
          // Build string a manually using __str_from_data
          // First write bytes to memory at offset 0
          ...writeStringToMemory(str, 0),
          // a = __str_from_data(0, len)
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: strBytes.length },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          // Write same bytes at offset 100
          ...writeStringToMemory(str, 100),
          // b = __str_from_data(100, len)
          { op: "i32.const", value: 100 },
          { op: "i32.const", value: strBytes.length },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          // Call __str_eq_simd(a, b)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi["__str_eq_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_eq", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_str_eq()).toBe(1);
  });

  it("returns 0 for different strings", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$test_type",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_str_ne",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory("hello", 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          ...writeStringToMemory("world", 100),
          { op: "i32.const", value: 100 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi["__str_eq_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_ne", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_str_ne()).toBe(0);
  });

  it("returns 0 for different length strings", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$test_type",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_str_diff_len",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory("hello", 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          ...writeStringToMemory("hello!", 100),
          { op: "i32.const", value: 100 },
          { op: "i32.const", value: 6 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi["__str_eq_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_diff_len", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_str_diff_len()).toBe(0);
  });

  it("handles empty strings", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$test_type",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_empty_eq",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi["__str_eq_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_empty_eq", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_empty_eq()).toBe(1);
  });

  it("handles long strings (>16 bytes, SIMD loop + scalar tail)", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$test_type",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      const longStr = "abcdefghijklmnopqrstuvwxyz0123456789"; // 36 bytes
      mod.functions.push({
        name: "test_long_eq",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory(longStr, 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: longStr.length },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          ...writeStringToMemory(longStr, 200),
          { op: "i32.const", value: 200 },
          { op: "i32.const", value: longStr.length },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi["__str_eq_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_long_eq", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_long_eq()).toBe(1);
  });
});

describe("SIMD string indexOf (__str_indexOf_simd)", () => {
  it("finds needle at the start", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_indexOf_start",
        typeIdx,
        locals: [
          { name: "h", type: { kind: "i32" } },
          { name: "n", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory("hello world", 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 11 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          ...writeStringToMemory("hello", 100),
          { op: "i32.const", value: 100 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_indexOf_start", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_indexOf_start()).toBe(0);
  });

  it("finds needle in the middle", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_indexOf_mid",
        typeIdx,
        locals: [
          { name: "h", type: { kind: "i32" } },
          { name: "n", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory("hello world", 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 11 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          ...writeStringToMemory("world", 100),
          { op: "i32.const", value: 100 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_indexOf_mid", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_indexOf_mid()).toBe(6);
  });

  it("returns -1 when needle not found", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_indexOf_notfound",
        typeIdx,
        locals: [
          { name: "h", type: { kind: "i32" } },
          { name: "n", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory("hello world", 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 11 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          ...writeStringToMemory("xyz", 100),
          { op: "i32.const", value: 100 },
          { op: "i32.const", value: 3 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_indexOf_notfound", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_indexOf_notfound()).toBe(-1);
  });

  it("returns correct result for empty needle", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_indexOf_empty",
        typeIdx,
        locals: [
          { name: "h", type: { kind: "i32" } },
          { name: "n", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory("hello", 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          { op: "i32.const", value: 100 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_indexOf_empty", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_indexOf_empty()).toBe(0);
  });

  it("handles long haystack with SIMD path", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      // 32 byte haystack, needle at position 20
      const haystack = "aaaaaaaaaaaaaaaaaaaaXYZDaaaaaaaa"; // 31 chars, XYZ at pos 20
      mod.functions.push({
        name: "test_indexOf_long",
        typeIdx,
        locals: [
          { name: "h", type: { kind: "i32" } },
          { name: "n", type: { kind: "i32" } },
        ],
        body: [
          ...writeStringToMemory(haystack, 0),
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: haystack.length },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 0 },
          ...writeStringToMemory("XYZD", 200),
          { op: "i32.const", value: 200 },
          { op: "i32.const", value: 4 },
          { op: "call", funcIdx: fi["__str_from_data"] },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__str_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_indexOf_long", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_indexOf_long()).toBe(20);
  });
});

describe("SIMD array indexOf (__arr_indexOf_simd)", () => {
  it("finds element in first 4 (SIMD path)", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_indexOf",
        typeIdx,
        locals: [{ name: "arr", type: { kind: "i32" } }],
        body: [
          // Create array and push 8 elements: [10, 20, 30, 40, 50, 60, 70, 80]
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi["__arr_new"] },
          { op: "local.set", index: 0 },
          ...[10, 20, 30, 40, 50, 60, 70, 80].flatMap(v => [
            { op: "local.get" as const, index: 0 },
            { op: "i32.const" as const, value: v },
            { op: "call" as const, funcIdx: fi["__arr_push"] },
          ]),
          // Search for 30 (should be index 2)
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 30 },
          { op: "call", funcIdx: fi["__arr_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_indexOf", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_indexOf()).toBe(2);
  });

  it("finds element in second SIMD chunk", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_indexOf2",
        typeIdx,
        locals: [{ name: "arr", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi["__arr_new"] },
          { op: "local.set", index: 0 },
          ...[10, 20, 30, 40, 50, 60, 70, 80].flatMap(v => [
            { op: "local.get" as const, index: 0 },
            { op: "i32.const" as const, value: v },
            { op: "call" as const, funcIdx: fi["__arr_push"] },
          ]),
          // Search for 70 (should be index 6, in second SIMD chunk)
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 70 },
          { op: "call", funcIdx: fi["__arr_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_indexOf2", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_indexOf2()).toBe(6);
  });

  it("returns -1 when element not found", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_notfound",
        typeIdx,
        locals: [{ name: "arr", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi["__arr_new"] },
          { op: "local.set", index: 0 },
          ...[10, 20, 30].flatMap(v => [
            { op: "local.get" as const, index: 0 },
            { op: "i32.const" as const, value: v },
            { op: "call" as const, funcIdx: fi["__arr_push"] },
          ]),
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 99 },
          { op: "call", funcIdx: fi["__arr_indexOf_simd"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_notfound", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_notfound()).toBe(-1);
  });
});

describe("SIMD array fill (__arr_fill_simd)", () => {
  it("fills entire array with value using SIMD", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_fill",
        typeIdx,
        locals: [{ name: "arr", type: { kind: "i32" } }],
        body: [
          // Create array with 8 elements initialized to 0
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi["__arr_new"] },
          { op: "local.set", index: 0 },
          ...[0, 0, 0, 0, 0, 0, 0, 0].flatMap(_ => [
            { op: "local.get" as const, index: 0 },
            { op: "i32.const" as const, value: 0 },
            { op: "call" as const, funcIdx: fi["__arr_push"] },
          ]),
          // Fill with value 42 from index 0 to 8
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 42 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 8 },
          { op: "call", funcIdx: fi["__arr_fill_simd"] },
          // Read element at index 5 (should be 42)
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi["__arr_get"] },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_fill", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_fill()).toBe(42);
  });

  it("fills partial range", async () => {
    const e = await buildWithSimd((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func", name: "$test_type", params: [], results: [{ kind: "i32" }],
      });
      // Returns two values packed: arr[1] * 1000 + arr[3]
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_fill_partial",
        typeIdx,
        locals: [{ name: "arr", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi["__arr_new"] },
          { op: "local.set", index: 0 },
          ...[1, 2, 3, 4, 5].flatMap(v => [
            { op: "local.get" as const, index: 0 },
            { op: "i32.const" as const, value: v },
            { op: "call" as const, funcIdx: fi["__arr_push"] },
          ]),
          // Fill from index 1 to 3 with value 99
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 99 },
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 3 },
          { op: "call", funcIdx: fi["__arr_fill_simd"] },
          // Return arr[0] * 10000 + arr[1] * 100 + arr[2]
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi["__arr_get"] },
          { op: "i32.const", value: 10000 },
          { op: "i32.mul" },
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 1 },
          { op: "call", funcIdx: fi["__arr_get"] },
          { op: "i32.const", value: 100 },
          { op: "i32.mul" },
          { op: "i32.add" },
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi["__arr_get"] },
          { op: "i32.add" },
          // Expected: 1 * 10000 + 99 * 100 + 99 = 19999
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_fill_partial", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_fill_partial()).toBe(19999);
  });
});

// ---- Helper ----

/** Generate instructions to write a string's bytes into linear memory at a given offset */
function writeStringToMemory(str: string, memOffset: number): Instr[] {
  const bytes = new TextEncoder().encode(str);
  const instrs: Instr[] = [];
  for (let i = 0; i < bytes.length; i++) {
    instrs.push(
      { op: "i32.const", value: memOffset + i },
      { op: "i32.const", value: bytes[i] },
      { op: "i32.store8", align: 0, offset: 0 },
    );
  }
  return instrs;
}
