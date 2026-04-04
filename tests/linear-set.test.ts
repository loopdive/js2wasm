import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  addRuntime,
  addUint8ArrayRuntime,
  addArrayRuntime,
  addStringRuntime,
  addMapRuntime,
  addSetRuntime,
} from "../src/codegen-linear/runtime.js";

async function buildWithSet(setup: (mod: ReturnType<typeof createEmptyModule>, fi: Record<string, number>) => void) {
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);
  addStringRuntime(mod);
  addMapRuntime(mod);
  addSetRuntime(mod);

  const fi: Record<string, number> = {};
  for (let i = 0; i < mod.functions.length; i++) {
    fi[mod.functions[i].name] = i;
  }

  setup(mod, fi);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports as Record<string, Function>;
}

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

describe("linear-set: Set runtime", () => {
  it("new set has size 0", async () => {
    const e = await buildWithSet((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_set_size",
        typeIdx,
        locals: [{ name: "s", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__set_new },
          { op: "local.set", index: 0 },
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__set_size },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_set_size", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_set_size()).toBe(0);
  });

  it("add and has", async () => {
    const e = await buildWithSet((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_set_add_has",
        typeIdx,
        locals: [
          { name: "s", type: { kind: "i32" } },
          { name: "key", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__set_new },
          { op: "local.set", index: 0 },
          ...makeCharStr(fi, 0x78), // "x"
          { op: "local.set", index: 1 },
          // Add "x"
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__set_add },
          // Has "x"
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__set_has },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_set_add_has", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_set_add_has()).toBe(1);
  });

  it("has returns 0 for missing key", async () => {
    const e = await buildWithSet((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_set_missing",
        typeIdx,
        locals: [
          { name: "s", type: { kind: "i32" } },
          { name: "key", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__set_new },
          { op: "local.set", index: 0 },
          ...makeCharStr(fi, 0x79), // "y"
          { op: "local.set", index: 1 },
          // Has "y" without adding → 0
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__set_has },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_set_missing", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_set_missing()).toBe(0);
  });

  it("adding same key twice doesn't increase size", async () => {
    const e = await buildWithSet((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_set_dup",
        typeIdx,
        locals: [
          { name: "s", type: { kind: "i32" } },
          { name: "key", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__set_new },
          { op: "local.set", index: 0 },
          ...makeCharStr(fi, 0x61), // "a"
          { op: "local.set", index: 1 },
          // Add "a" twice
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__set_add },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__set_add },
          // Size should be 1
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__set_size },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_set_dup", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_set_dup()).toBe(1);
  });

  it("size reflects number of distinct keys", async () => {
    const e = await buildWithSet((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_set_size_multi",
        typeIdx,
        locals: [
          { name: "s", type: { kind: "i32" } },
          { name: "k1", type: { kind: "i32" } },
          { name: "k2", type: { kind: "i32" } },
          { name: "k3", type: { kind: "i32" } },
        ],
        body: [
          { op: "i32.const", value: 16 },
          { op: "call", funcIdx: fi.__set_new },
          { op: "local.set", index: 0 },
          ...makeCharStr(fi, 0x61),
          { op: "local.set", index: 1 },
          ...makeCharStr(fi, 0x62),
          { op: "local.set", index: 2 },
          ...makeCharStr(fi, 0x63),
          { op: "local.set", index: 3 },
          // Add "a", "b", "c"
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fi.__set_add },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: fi.__set_add },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 3 },
          { op: "call", funcIdx: fi.__set_add },
          // Size should be 3
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__set_size },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_set_size_multi", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_set_size_multi()).toBe(3);
  });
});
