import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  addRuntime,
  addUint8ArrayRuntime,
} from "../src/codegen-linear/runtime.js";
import type { Instr, FuncTypeDef, ValType } from "../src/ir/types.js";

/** Build a module with runtime + Uint8Array support and custom test functions */
async function buildWithU8Array(
  setup: (mod: ReturnType<typeof createEmptyModule>, funcIndices: Record<string, number>) => void,
) {
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);

  // Build funcIndices for runtime functions
  const funcIndices: Record<string, number> = {};
  for (let i = 0; i < mod.functions.length; i++) {
    funcIndices[mod.functions[i].name] = i;
  }

  setup(mod, funcIndices);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-u8array: Uint8Array runtime", () => {
  it("creates a Uint8Array and reads its length", async () => {
    const e = await buildWithU8Array((mod, fi) => {
      // test_u8arr_len(len: i32) → i32: create array of `len` bytes, return its length
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [{ kind: "i32" }],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_u8arr_len",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__u8arr_new },
          { op: "local.set", index: 1 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__u8arr_len },
        ],
        exported: true,
      });
      mod.exports.push({
        name: "test_u8arr_len",
        desc: { kind: "func", index: funcIdx },
      });
    });
    expect(e.test_u8arr_len(10)).toBe(10);
    expect(e.test_u8arr_len(0)).toBe(0);
    expect(e.test_u8arr_len(255)).toBe(255);
  });

  it("sets and gets bytes", async () => {
    const e = await buildWithU8Array((mod, fi) => {
      // test_u8arr_setget(val: i32) → i32: create 4-byte array, set index 2, get index 2
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [{ kind: "i32" }],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_u8arr_setget",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          // Create array of 4 bytes
          { op: "i32.const", value: 4 },
          { op: "call", funcIdx: fi.__u8arr_new },
          { op: "local.set", index: 1 },
          // Set index 2 to val
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 2 },
          { op: "local.get", index: 0 }, // val
          { op: "call", funcIdx: fi.__u8arr_set },
          // Get index 2
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi.__u8arr_get },
        ],
        exported: true,
      });
      mod.exports.push({
        name: "test_u8arr_setget",
        desc: { kind: "func", index: funcIdx },
      });
    });
    expect(e.test_u8arr_setget(42)).toBe(42);
    expect(e.test_u8arr_setget(255)).toBe(255);
    expect(e.test_u8arr_setget(0)).toBe(0);
  });
});
