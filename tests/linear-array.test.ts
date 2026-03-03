import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  addRuntime,
  addUint8ArrayRuntime,
  addArrayRuntime,
} from "../src/codegen-linear/runtime.js";

async function buildWithArray(
  setup: (mod: ReturnType<typeof createEmptyModule>, fi: Record<string, number>) => void,
) {
  const mod = createEmptyModule();
  addRuntime(mod);
  addUint8ArrayRuntime(mod);
  addArrayRuntime(mod);

  const fi: Record<string, number> = {};
  for (let i = 0; i < mod.functions.length; i++) {
    fi[mod.functions[i].name] = i;
  }

  setup(mod, fi);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-array: Array runtime", () => {
  it("creates an array and reads its length (0 initially)", async () => {
    const e = await buildWithArray((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_len",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 8 }, // capacity 8
          { op: "call", funcIdx: fi.__arr_new },
          { op: "local.set", index: 0 },
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__arr_len },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_len", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_len()).toBe(0);
  });

  it("pushes elements and reads length", async () => {
    const e = await buildWithArray((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_push_len",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 8 },
          { op: "call", funcIdx: fi.__arr_new },
          { op: "local.set", index: 0 },
          // push 3 elements
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 10 },
          { op: "call", funcIdx: fi.__arr_push },
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 20 },
          { op: "call", funcIdx: fi.__arr_push },
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 30 },
          { op: "call", funcIdx: fi.__arr_push },
          // Get length
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: fi.__arr_len },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_push_len", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_push_len()).toBe(3);
  });

  it("gets elements by index", async () => {
    const e = await buildWithArray((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [{ kind: "i32" }],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_get",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 8 },
          { op: "call", funcIdx: fi.__arr_new },
          { op: "local.set", index: 1 },
          // push 100, 200, 300
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 100 },
          { op: "call", funcIdx: fi.__arr_push },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 200 },
          { op: "call", funcIdx: fi.__arr_push },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 300 },
          { op: "call", funcIdx: fi.__arr_push },
          // Get at index param
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // idx
          { op: "call", funcIdx: fi.__arr_get },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_get", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_get(0)).toBe(100);
    expect(e.test_arr_get(1)).toBe(200);
    expect(e.test_arr_get(2)).toBe(300);
  });

  it("sets elements by index", async () => {
    const e = await buildWithArray((mod, fi) => {
      const typeIdx = mod.types.length;
      mod.types.push({
        kind: "func",
        name: "$type_test",
        params: [],
        results: [{ kind: "i32" }],
      });
      const funcIdx = mod.functions.length;
      mod.functions.push({
        name: "test_arr_set",
        typeIdx,
        locals: [{ name: "ptr", type: { kind: "i32" } }],
        body: [
          { op: "i32.const", value: 4 },
          { op: "call", funcIdx: fi.__arr_new },
          { op: "local.set", index: 0 },
          // push 2 elements
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi.__arr_push },
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "call", funcIdx: fi.__arr_push },
          // Set index 1 to 999
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 1 },
          { op: "i32.const", value: 999 },
          { op: "call", funcIdx: fi.__arr_set },
          // Get index 1
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 1 },
          { op: "call", funcIdx: fi.__arr_get },
        ],
        exported: true,
      });
      mod.exports.push({ name: "test_arr_set", desc: { kind: "func", index: funcIdx } });
    });
    expect(e.test_arr_set()).toBe(999);
  });
});
