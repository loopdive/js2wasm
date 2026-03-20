import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitWat } from "../src/emit/wat.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/ir/types.js";

describe("SIMD WAT text emission", () => {
  it("emits v128 type in locals and function signatures", () => {
    const mod = createEmptyModule();
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$simd_func_type",
      params: [{ kind: "v128" }],
      results: [{ kind: "v128" }],
    });
    mod.functions.push({
      name: "test_v128",
      typeIdx,
      locals: [{ name: "tmp", type: { kind: "v128" } }],
      body: [{ op: "local.get", index: 0 }],
      exported: false,
    });
    const wat = emitWat(mod);
    // v128 should appear in the output for param, result, and local
    expect(wat).toContain("v128");
    expect(wat).toContain("(local $tmp v128)");
  });

  it("emits v128.const with hex bytes", () => {
    const mod = createEmptyModule();
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$const_type",
      params: [],
      results: [{ kind: "v128" }],
    });
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    mod.functions.push({
      name: "test_const",
      typeIdx,
      locals: [],
      body: [{ op: "v128.const", bytes }],
      exported: false,
    });
    const wat = emitWat(mod);
    expect(wat).toContain("v128.const i8x16");
    expect(wat).toContain("0x01");
    expect(wat).toContain("0x10");
  });

  it("emits SIMD lane operations with lane index", () => {
    const mod = createEmptyModule();
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$lane_type",
      params: [{ kind: "i32" }],
      results: [{ kind: "i32" }],
    });
    mod.functions.push({
      name: "test_lane",
      typeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "i32x4.splat" } as Instr,
        { op: "i32x4.extract_lane", lane: 2 } as Instr,
      ],
      exported: false,
    });
    const wat = emitWat(mod);
    expect(wat).toContain("i32x4.splat");
    expect(wat).toContain("i32x4.extract_lane 2");
  });

  it("emits v128.load/store with offset and align", () => {
    const mod = createEmptyModule();
    mod.memories.push({ min: 1 });
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$mem_type",
      params: [],
      results: [],
    });
    mod.functions.push({
      name: "test_mem",
      typeIdx,
      locals: [{ name: "v", type: { kind: "v128" } }],
      body: [
        { op: "i32.const", value: 0 },
        { op: "v128.load", align: 4, offset: 16 } as Instr,
        { op: "local.set", index: 0 },
        { op: "i32.const", value: 32 },
        { op: "local.get", index: 0 },
        { op: "v128.store", align: 4, offset: 0 } as Instr,
      ],
      exported: false,
    });
    const wat = emitWat(mod);
    expect(wat).toContain("v128.load offset=16 align=16");
    expect(wat).toContain("v128.store offset=0 align=16");
  });

  it("emits i8x16.shuffle with lane indices", () => {
    const mod = createEmptyModule();
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$shuffle_type",
      params: [],
      results: [{ kind: "v128" }],
    });
    const allZero = new Uint8Array(16);
    mod.functions.push({
      name: "test_shuffle",
      typeIdx,
      locals: [],
      body: [
        { op: "v128.const", bytes: allZero },
        { op: "v128.const", bytes: allZero },
        { op: "i8x16.shuffle", lanes: [0, 1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23] } as Instr,
      ],
      exported: false,
    });
    const wat = emitWat(mod);
    expect(wat).toContain("i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23");
  });
});

describe("SIMD binary roundtrip", () => {
  it("module with SIMD memcmp validates and instantiates", async () => {
    // Build a minimal module that does SIMD memcmp on linear memory
    const mod = createEmptyModule();
    mod.memories.push({ min: 1 });
    mod.exports.push({ name: "memory", desc: { kind: "memory", index: 0 } });

    // Function type: (i32, i32, i32) -> i32
    // memcmp(ptr_a, ptr_b, len) -> 1 if equal, 0 if not
    const typeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: "$memcmp_type",
      params: [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      results: [{ kind: "i32" }],
    });

    const body: Instr[] = [
      // local 3 = i (loop counter)
      // SIMD loop: compare 16 bytes at a time
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          // if i + 16 > len, break to scalar tail
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 16 },
          { op: "i32.add" },
          { op: "local.get", index: 2 },
          { op: "i32.gt_u" },
          { op: "br_if", depth: 1 },

          // v128.load(ptr_a + i) == v128.load(ptr_b + i)?
          { op: "local.get", index: 0 },
          { op: "local.get", index: 3 },
          { op: "i32.add" },
          { op: "v128.load", align: 0, offset: 0 },

          { op: "local.get", index: 1 },
          { op: "local.get", index: 3 },
          { op: "i32.add" },
          { op: "v128.load", align: 0, offset: 0 },

          { op: "i8x16.eq" } as Instr,
          { op: "i8x16.all_true" } as Instr,
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: [
            { op: "i32.const", value: 0 },
            { op: "return" },
          ] },

          // i += 16
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 16 },
          { op: "i32.add" },
          { op: "local.set", index: 3 },
          { op: "br", depth: 0 },
        ] },
      ] },

      // Scalar tail: byte-by-byte
      { op: "block", blockType: { kind: "empty" }, body: [
        { op: "loop", blockType: { kind: "empty" }, body: [
          { op: "local.get", index: 3 },
          { op: "local.get", index: 2 },
          { op: "i32.ge_u" },
          { op: "br_if", depth: 1 },

          { op: "local.get", index: 0 },
          { op: "local.get", index: 3 },
          { op: "i32.add" },
          { op: "i32.load8_u", align: 0, offset: 0 },

          { op: "local.get", index: 1 },
          { op: "local.get", index: 3 },
          { op: "i32.add" },
          { op: "i32.load8_u", align: 0, offset: 0 },

          { op: "i32.ne" },
          { op: "if", blockType: { kind: "empty" }, then: [
            { op: "i32.const", value: 0 },
            { op: "return" },
          ] },

          { op: "local.get", index: 3 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: 3 },
          { op: "br", depth: 0 },
        ] },
      ] },

      // All equal
      { op: "i32.const", value: 1 },
    ];

    const funcIdx = mod.functions.length;
    mod.functions.push({
      name: "simd_memcmp",
      typeIdx,
      locals: [{ name: "i", type: { kind: "i32" } }],
      body,
      exported: true,
    });
    mod.exports.push({ name: "simd_memcmp", desc: { kind: "func", index: funcIdx } });

    // Emit binary
    const binary = emitBinary(mod);
    expect(binary).toBeInstanceOf(Uint8Array);

    // Validate and instantiate
    const { instance } = await WebAssembly.instantiate(binary);
    const memcmp = instance.exports.simd_memcmp as (a: number, b: number, len: number) => number;
    const memory = instance.exports.memory as WebAssembly.Memory;
    const view = new Uint8Array(memory.buffer);

    // Write identical data at offset 0 and 256
    const testData = new TextEncoder().encode("Hello, SIMD World! This is a test of vectorized comparison.");
    view.set(testData, 0);
    view.set(testData, 256);
    expect(memcmp(0, 256, testData.length)).toBe(1);

    // Modify one byte and check inequality
    view[260] = 0xFF;
    expect(memcmp(0, 256, testData.length)).toBe(0);

    // Empty comparison should return equal
    expect(memcmp(0, 256, 0)).toBe(1);

    // Exact 16-byte comparison (single SIMD op, no scalar tail)
    view.set(testData.slice(0, 16), 512);
    view.set(testData.slice(0, 16), 528);
    expect(memcmp(512, 528, 16)).toBe(1);

    // Modify last byte of 16-byte block
    view[543] = 0xFF;
    expect(memcmp(512, 528, 16)).toBe(0);
  });
});
