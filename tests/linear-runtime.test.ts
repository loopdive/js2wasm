import { describe, it, expect } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { addRuntime } from "../src/codegen-linear/runtime.js";

/** Build a minimal module with just the runtime, compile and instantiate it */
async function buildRuntimeModule(
  setup?: (mod: ReturnType<typeof createEmptyModule>) => void,
) {
  const mod = createEmptyModule();
  addRuntime(mod);
  if (setup) setup(mod);
  const binary = emitBinary(mod);
  const { instance } = await WebAssembly.instantiate(binary);
  return instance;
}

describe("linear-runtime: bump allocator", () => {
  it("exports memory", async () => {
    const inst = await buildRuntimeModule();
    expect(inst.exports.memory).toBeInstanceOf(WebAssembly.Memory);
  });

  it("__malloc returns aligned pointers starting at 1024", async () => {
    // We need to export __malloc to test it directly
    const mod = createEmptyModule();
    addRuntime(mod);
    // Export __malloc for testing
    const mallocFuncIdx = mod.functions.findIndex(
      (f) => f.name === "__malloc",
    );
    mod.exports.push({
      name: "__malloc",
      desc: { kind: "func", index: mallocFuncIdx },
    });
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const malloc = instance.exports.__malloc as Function;

    // First allocation starts at 1024
    const ptr1 = malloc(10);
    expect(ptr1).toBe(1024);

    // Second allocation is 8-byte aligned after first
    const ptr2 = malloc(4);
    // 1024 + 10 = 1034, aligned to 8 → 1040
    expect(ptr2).toBe(1040);

    // Third allocation
    const ptr3 = malloc(16);
    // 1040 + 4 = 1044, aligned to 8 → 1048
    expect(ptr3).toBe(1048);
  });

  it("__malloc aligns to 8 bytes", async () => {
    const mod = createEmptyModule();
    addRuntime(mod);
    const mallocFuncIdx = mod.functions.findIndex(
      (f) => f.name === "__malloc",
    );
    mod.exports.push({
      name: "__malloc",
      desc: { kind: "func", index: mallocFuncIdx },
    });
    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const malloc = instance.exports.__malloc as Function;

    const ptr1 = malloc(1);
    expect(ptr1 % 8).toBe(0); // 1024 is 8-aligned

    const ptr2 = malloc(1);
    expect(ptr2 % 8).toBe(0); // should be 8-aligned
  });
});
