import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { addRuntime, addUint8ArrayRuntime, addArrayRuntime, addStringRuntime } from "../src/codegen-linear/runtime.js";

async function buildWithString(setup: (mod: ReturnType<typeof createEmptyModule>, fi: Record<string, number>) => void) {
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);

  const fi: Record<string, number> = {};
  for (let i = 0; i < mod.functions.length; i++) {
    fi[mod.functions[i].name] = i;
  }

  setup(mod, fi);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-string: String runtime", () => {
  it("__str_len returns length of a string created with __str_from_data", async () => {
    const e = await buildWithString((mod, fi) => {
      // We'll manually write "hello" (5 bytes) into memory at offset 0
      // and use __str_from_data to create a string from it
      // For this test we write bytes directly via i32.store8 instructions
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_str_len",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          // Write "hello" at offset 0 in memory
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0x68 }, // 'h'
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 0x65 }, // 'e'
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 2 },
          { op: "i32.const", value: 0x6c }, // 'l'
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 3 },
          { op: "i32.const", value: 0x6c }, // 'l'
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 4 },
          { op: "i32.const", value: 0x6f }, // 'o'
          { op: "i32.store8", align: 0, offset: 0 },
          // Create string from data at offset 0, length 5
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 5 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 0 },
          // Return length
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__str_len },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_len", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_str_len()).toBe(5);
  });

  it("__str_eq compares equal strings", async () => {
    const e = await buildWithString((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_str_eq",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
        ],
        body: [
          // Write "ab" at offset 0
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0x61 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 0x62 },
          { op: "i32.store8", align: 0, offset: 0 },
          // Create string a
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 0 },
          // Write "ab" at offset 16 (fresh area)
          { op: "i32.const", value: 16 },
          { op: "i32.const", value: 0x61 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 17 },
          { op: "i32.const", value: 0x62 },
          { op: "i32.store8", align: 0, offset: 0 },
          // Create string b
          { op: "i32.const", value: 16 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 1 },
          // Compare
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__str_eq },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_eq", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_str_eq()).toBe(1);
  });

  it("__str_eq returns 0 for different strings", async () => {
    const e = await buildWithString((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_str_neq",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
        ],
        body: [
          // Write "ab" at offset 0
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0x61 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 0x62 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 0 },
          // Write "cd" at offset 16
          { op: "i32.const", value: 16 },
          { op: "i32.const", value: 0x63 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 17 },
          { op: "i32.const", value: 0x64 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 16 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 1 },
          // Compare
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__str_eq },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_neq", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_str_neq()).toBe(0);
  });

  it("__str_hash produces consistent non-zero hashes", async () => {
    const e = await buildWithString((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_str_hash",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          // Write "a" at offset 0
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0x61 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 1 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 0 },
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__str_hash },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_hash", desc: { kind: "func", index: funcIdx } });
    });
    const hash = e.test_str_hash();
    // FNV-1a hash of "a" should be a specific non-zero value
    expect(hash).not.toBe(0);
    // Call again - should be consistent
    expect(e.test_str_hash()).toBe(hash);
  });

  it("__str_concat joins two strings", async () => {
    const e = await buildWithString((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_str_concat_len",
        typeIdx,
        locals: [
          { name: "a", type: { kind: "i32" } },
          { name: "b", type: { kind: "i32" } },
          { name: "c", type: { kind: "i32" } },
        ],
        body: [
          // Write "he" at offset 0
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0x68 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 0x65 },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 0 },
          // Write "llo" at offset 16
          { op: "i32.const", value: 16 },
          { op: "i32.const", value: 0x6c },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 17 },
          { op: "i32.const", value: 0x6c },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 18 },
          { op: "i32.const", value: 0x6f },
          { op: "i32.store8", align: 0, offset: 0 },
          { op: "i32.const", value: 16 },
          { op: "i32.const", value: 3 },
          { op: "call", funcIdx: fi.__str_from_data },
          { op: "local.set", index: 1 },
          // Concat
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__str_concat },
          { op: "local.set", index: 2 },
          // Return length of concatenated string
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: fi.__str_len },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_str_concat_len", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_str_concat_len()).toBe(5); // "he" + "llo" = "hello" (5 bytes)
  });
});
