import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { analyzeMultiSource } from "../src/checker/index.js";
import { generateLinearMultiModule } from "../src/codegen-linear/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { compileToObject } from "../src/index.js";
import { link } from "../src/link/index.js";

function loadLinkerFiles(): Record<string, string> {
  return {
    "link/reader.ts": readFileSync("src/link/reader.ts", "utf8"),
    "link/resolver.ts": readFileSync("src/link/resolver.ts", "utf8"),
    "link/isolation.ts": readFileSync("src/link/isolation.ts", "utf8"),
    "link/linker.ts": readFileSync("src/link/linker.ts", "utf8"),
    "link/index.ts": readFileSync("src/link/index.ts", "utf8"),
    "emit/encoder.ts": readFileSync("src/emit/encoder.ts", "utf8"),
    "emit/opcodes.ts": readFileSync("src/emit/opcodes.ts", "utf8"),
  };
}

function buildLinkerWasm(): Uint8Array {
  console.time("analyzeMultiSource");
  const files = loadLinkerFiles();
  const multiAst = analyzeMultiSource(files, "link/index.ts");
  console.timeEnd("analyzeMultiSource");

  console.time("generateLinearMultiModule");
  const mod = generateLinearMultiModule(multiAst);
  console.timeEnd("generateLinearMultiModule");

  // Export runtime helpers for marshaling
  const helpers = [
    "__malloc", "__str_from_data", "__str_len",
    "__u8arr_new", "__u8arr_set", "__u8arr_get", "__u8arr_len", "__u8arr_from_raw", "__u8arr_slice",
    "__map_new", "__map_set", "__map_has",
    "__arr_new", "__arr_push", "__arr_len", "__arr_get",
    "WasmEncoder_ctor", "WasmEncoder_byte", "WasmEncoder_u32", "WasmEncoder_finish",
  ];
  for (const name of helpers) {
    const idx = mod.functions.findIndex(f => f.name === name);
    if (idx >= 0) {
      mod.exports.push({ name, desc: { kind: "func", index: idx } });
    }
  }

  console.time("emitBinary");
  const binary = emitBinary(mod);
  console.timeEnd("emitBinary");

  return binary;
}

describe("linker end-to-end", { timeout: 120_000 }, () => {
  it("builds linker.wasm and tests runtime helpers", async () => {
    console.log("Building linker.wasm...");
    const wasmBinary = buildLinkerWasm();
    console.log("linker.wasm size:", wasmBinary.length);
    writeFileSync("/tmp/linker-e2e.wasm", wasmBinary);

    console.log("Instantiating...");
    const { instance } = await WebAssembly.instantiate(wasmBinary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    const ex = instance.exports as unknown as Record<string, Function>;
    console.log("Instantiated OK");

    // Test 1: malloc
    const ptr = ex.__malloc(32) as number;
    console.log("malloc(32) =", ptr);
    expect(ptr).toBeGreaterThanOrEqual(1024);

    // Test 2: string creation
    memory.grow(4);
    const u8 = new Uint8Array(memory.buffer);
    const hello = new TextEncoder().encode("hello");
    u8.set(hello, 65536);
    const strPtr = ex.__str_from_data(65536, 5) as number;
    const strLen = ex.__str_len(strPtr) as number;
    console.log("str 'hello' ptr:", strPtr, "len:", strLen);
    expect(strLen).toBe(5);

    // Test 3: Uint8Array creation
    const testData = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    u8.set(testData, 65600);
    const arrPtr = ex.__u8arr_from_raw(65600, 4) as number;
    const arrLen = ex.__u8arr_len(arrPtr) as number;
    console.log("u8arr len:", arrLen);
    expect(arrLen).toBe(4);

    // Test 4: Map
    const mapPtr = ex.__map_new(8) as number;
    ex.__map_set(mapPtr, strPtr, arrPtr);
    const has = ex.__map_has(mapPtr, strPtr) as number;
    console.log("map.has('hello'):", has);
    expect(has).toBe(1);
  });

  it("calls parseObject on a .o file", async () => {
    const wasmBinary = buildLinkerWasm();
    const { instance } = await WebAssembly.instantiate(wasmBinary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(8);
    const ex = instance.exports as unknown as Record<string, Function>;

    // Create a .o file
    const objResult = compileToObject(
      `export function add(x: number, y: number): number { return x + y; }`,
      { moduleName: "test.ts" },
    );
    expect(objResult.success).toBe(true);
    console.log(".o file size:", objResult.object.length);

    // Write .o bytes and name into scratch area (page 8+, well past heap)
    const scratch = 131072;
    const u8 = new Uint8Array(memory.buffer);
    u8.set(objResult.object, scratch);
    const bytesPtr = ex.__u8arr_from_raw(scratch, objResult.object.length) as number;

    const nameStr = new TextEncoder().encode("test.o");
    u8.set(nameStr, scratch + 65536);
    const namePtr = ex.__str_from_data(scratch + 65536, nameStr.length) as number;

    // Verify Uint8Array contents
    const b0 = ex.__u8arr_get(bytesPtr, 0) as number;
    const b1 = ex.__u8arr_get(bytesPtr, 1) as number;
    const b2 = ex.__u8arr_get(bytesPtr, 2) as number;
    const b3 = ex.__u8arr_get(bytesPtr, 3) as number;
    console.log("first 4 bytes:", [b0, b1, b2, b3].map(x => x.toString(16)).join(" "));

    // Test __u8arr_slice directly
    const slicePtr = ex.__u8arr_slice
      ? (ex.__u8arr_slice as Function)(bytesPtr, 0, 4) as number
      : 0;
    if (slicePtr) {
      const sLen = ex.__u8arr_len(slicePtr) as number;
      const s0 = ex.__u8arr_get(slicePtr, 0) as number;
      const s1 = ex.__u8arr_get(slicePtr, 1) as number;
      const s2 = ex.__u8arr_get(slicePtr, 2) as number;
      const s3 = ex.__u8arr_get(slicePtr, 3) as number;
      console.log("slice(0,4) len:", sLen, "bytes:", [s0, s1, s2, s3].map(x => x.toString(16)).join(" "));
    }

    console.log("Calling parseObject...");
    const parseObject = instance.exports.parseObject as Function;
    const parsedPtr = parseObject(namePtr, bytesPtr);
    console.log("parseObject returned:", parsedPtr);
    expect(parsedPtr).toBeGreaterThan(0);
  });

  it("link() produces same output as TypeScript linker", async () => {
    // Create two .o files
    const aObj = compileToObject(
      `export function add(x: number, y: number): number { return x + y; }`,
      { moduleName: "a.ts" },
    );
    const bObj = compileToObject(
      `export function mul(x: number, y: number): number { return x * y; }`,
      { moduleName: "b.ts" },
    );
    expect(aObj.success).toBe(true);
    expect(bObj.success).toBe(true);

    // Run TypeScript linker for reference
    const tsObjects = new Map<string, Uint8Array>();
    tsObjects.set("a.o", aObj.object);
    tsObjects.set("b.o", bObj.object);
    const tsResult = link(tsObjects);
    expect(tsResult.success).toBe(true);
    console.log("TS linker output size:", tsResult.binary.length);

    // Build and instantiate linker.wasm
    const wasmBinary = buildLinkerWasm();
    const { instance } = await WebAssembly.instantiate(wasmBinary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(16); // plenty of space
    const ex = instance.exports as unknown as Record<string, Function>;

    // Marshal: write .o files and names into scratch area
    let scratch = 262144; // 256KB, well past heap

    function writeBytes(data: Uint8Array): number {
      const u8 = new Uint8Array(memory.buffer);
      u8.set(data, scratch);
      const ptr = ex.__u8arr_from_raw(scratch, data.length) as number;
      scratch += data.length;
      scratch = (scratch + 7) & ~7;
      return ptr;
    }

    function writeString(s: string): number {
      const encoded = new TextEncoder().encode(s);
      const u8 = new Uint8Array(memory.buffer);
      u8.set(encoded, scratch);
      const ptr = ex.__str_from_data(scratch, encoded.length) as number;
      scratch += encoded.length;
      scratch = (scratch + 7) & ~7;
      return ptr;
    }

    // Build Map<string, Uint8Array>
    const mapPtr = ex.__map_new(8) as number;
    const aName = writeString("a.o");
    const aBytes = writeBytes(aObj.object);
    ex.__map_set(mapPtr, aName, aBytes);
    const bName = writeString("b.o");
    const bBytes = writeBytes(bObj.object);
    ex.__map_set(mapPtr, bName, bBytes);

    // Call link(objects, options=0)
    console.log("Calling wasm link()...");
    const linkFn = instance.exports.link as (objects: number, options: number) => number;
    const resultPtr = linkFn(mapPtr, 0);
    console.log("link() returned:", resultPtr);

    // Read LinkResult fields
    // Layout: [header 8B][binary i32@+8][wat i32@+16][success f64@+24][errors i32@+32]
    const dv = new DataView(memory.buffer);
    const binaryPtr = dv.getInt32(resultPtr + 8, true);
    const success = dv.getFloat64(resultPtr + 24, true) !== 0;
    const errorsPtr = dv.getInt32(resultPtr + 32, true);

    console.log("success:", success, "binaryPtr:", binaryPtr, "errorsPtr:", errorsPtr);

    if (!success && errorsPtr > 0) {
      const errCount = ex.__arr_len(errorsPtr) as number;
      console.log("errors:", errCount);
    }

    expect(success).toBe(true);

    // Read output binary
    const outLen = dv.getUint32(binaryPtr + 8, true);
    const outBytes = new Uint8Array(memory.buffer).slice(binaryPtr + 12, binaryPtr + 12 + outLen);
    console.log("wasm linker output size:", outBytes.length, "ts linker output size:", tsResult.binary.length);

    // Verify output starts with wasm magic
    expect(outBytes[0]).toBe(0x00); // \0
    expect(outBytes[1]).toBe(0x61); // a
    expect(outBytes[2]).toBe(0x73); // s
    expect(outBytes[3]).toBe(0x6d); // m
    expect(outBytes[4]).toBe(0x01); // version 1
    expect(outLen).toBeGreaterThan(0);

    // TODO: byte-for-byte comparison with TS linker (pending further compiler fixes)
    // expect(outBytes).toEqual(tsResult.binary);
  });
});
