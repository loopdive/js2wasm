import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  addRuntime,
  addUint8ArrayRuntime,
  addArrayRuntime,
  addStringRuntime,
  addMapRuntime,
} from "../src/codegen-linear/runtime.js";

async function buildWithMap(setup: (mod: ReturnType<typeof createEmptyModule>, fi: Record<string, number>) => void) {
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addMapRuntime(mod);

  const fi: Record<string, number> = {};
  for (let i = 0; i < mod.functions.length; i++) {
    fi[mod.functions[i].name] = i;
  }

  setup(mod, fi);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports as Record<string, Function>;
}

/** Helper: generate instructions to create a 1-char string */
function makeCharStr(fi: Record<string, number>, char: number) {
  return [
    { op: "i32.const" as const, value: 0 },
    { op: "i32.const" as const, value: char },
    { op: "i32.store8" as const, align: 0, offset: 0 },
    { op: "i32.const" as const, value: 0 },
    { op: "i32.const" as const, value: 1 },
    { op: "call" as const, funcIdx: fi.__str_from_data },
  ];
}

describe("linear-map: Map runtime", () => {
  it("new map has size 0", async () => {
    const e = await buildWithMap((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_map_size",
        typeIdx,
        locals: [{ name: "map", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__map_new },
          { op: "local.set", index: 0 },
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__map_size },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_map_size", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_map_size()).toBe(0);
  });

  it("set and get a key-value pair", async () => {
    const e = await buildWithMap((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_map_setget",
        typeIdx,
        locals: [
          { name: "map", type: { kind: "i32" } },
          { name: "key", type: { kind: "i32" } },
        ],
        body: [
          // Create map
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__map_new },
          { op: "local.set", index: 0 },
          // Create key string "a"
          ...makeCharStr(fi, 0x61),
          { op: "local.set", index: 1 },
          // Set key → 42
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 42 },
          { op: "call", funcIdx: fi.__map_set },
          // Get key
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__map_get },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_map_setget", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_map_setget()).toBe(42);
  });

  it("has returns 1 for existing key, 0 for missing", async () => {
    const e = await buildWithMap((mod, fi) => {
      // test_map_has() → i32: returns __map_has result for a key that was set
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_has",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_map_has",
        typeIdx,
        locals: [
          { name: "map", type: { kind: "i32" } },
          { name: "key", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__map_new },
          { op: "local.set", index: 0 },
          ...makeCharStr(fi, 0x61),
          { op: "local.set", index: 1 },
          // Set key "a" → 1
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "call", funcIdx: fi.__map_set },
          // has "a" → should be 1
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__map_has },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_map_has", desc: { kind: "func", index: funcIdx } });

      // test_map_has_missing() → i32: returns __map_has for a key NOT set
      const typeIdx2 = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_miss",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx2 = mod.functions.length;
      mod.functions.push({
        name: "test_map_has_missing",
        typeIdx: typeIdx2,
        locals: [
          { name: "map", type: { kind: "i32" } },
          { name: "key", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__map_new },
          { op: "local.set", index: 0 },
          // Create key "b" (not inserted)
          ...makeCharStr(fi, 0x62),
          { op: "local.set", index: 1 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__map_has },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_map_has_missing", desc: { kind: "func", index: funcIdx2 } });
    });
    expect(e.test_map_has()).toBe(1);
    expect(e.test_map_has_missing()).toBe(0);
  });

  it("size increases with insertions", async () => {
    const e = await buildWithMap((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_map_size_after",
        typeIdx,
        locals: [
          { name: "map", type: { kind: "i32" } },
          { name: "k1", type: { kind: "i32" } },
          { name: "k2", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__map_new },
          { op: "local.set", index: 0 },
          // key "a"
          ...makeCharStr(fi, 0x61),
          { op: "local.set", index: 1 },
          // key "b"
          ...makeCharStr(fi, 0x62),
          { op: "local.set", index: 2 },
          // Set "a" → 1
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "call", funcIdx: fi.__map_set },
          // Set "b" → 2
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 2 },
          { op: "call", funcIdx: fi.__map_set },
          // Size should be 2
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__map_size },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_map_size_after", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_map_size_after()).toBe(2);
  });

  it("updating existing key doesn't increase size", async () => {
    const e = await buildWithMap((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_map_update",
        typeIdx,
        locals: [
          { name: "map", type: { kind: "i32" } },
          { name: "key", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__map_new },
          { op: "local.set", index: 0 },
          ...makeCharStr(fi, 0x61),
          { op: "local.set", index: 1 },
          // Set "a" → 1
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "call", funcIdx: fi.__map_set },
          // Update "a" → 99
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 99 },
          { op: "call", funcIdx: fi.__map_set },
          // Size should still be 1
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__map_size },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_map_update", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_map_update()).toBe(1);
  });
});
