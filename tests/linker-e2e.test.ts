import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
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
  const files = loadLinkerFiles();
  const multiAst = analyzeMultiSource(files, "link/index.ts");
  const mod = generateLinearMultiModule(multiAst);

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

  return emitBinary(mod);
}

describe("linker end-to-end", { timeout: 120_000 }, () => {
  it("builds linker.wasm and tests runtime helpers", async () => {
    const wasmBinary = buildLinkerWasm();
    const { instance } = await WebAssembly.instantiate(wasmBinary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    const ex = instance.exports as unknown as Record<string, Function>;

    // malloc
    const ptr = ex.__malloc(32) as number;
    expect(ptr).toBeGreaterThanOrEqual(1024);

    // string creation
    memory.grow(4);
    const u8 = new Uint8Array(memory.buffer);
    const hello = new TextEncoder().encode("hello");
    u8.set(hello, 65536);
    const strPtr = ex.__str_from_data(65536, 5) as number;
    expect(ex.__str_len(strPtr)).toBe(5);

    // Uint8Array creation
    const testData = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    u8.set(testData, 65600);
    const arrPtr = ex.__u8arr_from_raw(65600, 4) as number;
    expect(ex.__u8arr_len(arrPtr)).toBe(4);

    // Map
    const mapPtr = ex.__map_new(8) as number;
    ex.__map_set(mapPtr, strPtr, arrPtr);
    expect(ex.__map_has(mapPtr, strPtr)).toBe(1);
  });

  it("calls parseObject on a .o file", async () => {
    const wasmBinary = buildLinkerWasm();
    const { instance } = await WebAssembly.instantiate(wasmBinary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(8);
    const ex = instance.exports as unknown as Record<string, Function>;

    const objResult = compileToObject(
      `export function add(x: number, y: number): number { return x + y; }`,
      { moduleName: "test.ts" },
    );
    expect(objResult.success).toBe(true);

    // Write .o bytes and name into scratch area (well past heap)
    const scratch = 131072;
    const u8 = new Uint8Array(memory.buffer);
    u8.set(objResult.object, scratch);
    const bytesPtr = ex.__u8arr_from_raw(scratch, objResult.object.length) as number;

    const nameStr = new TextEncoder().encode("test.o");
    u8.set(nameStr, scratch + 65536);
    const namePtr = ex.__str_from_data(scratch + 65536, nameStr.length) as number;

    // parseObject returns a valid ParsedObject pointer
    const parseObject = instance.exports.parseObject as Function;
    const parsedPtr = parseObject(namePtr, bytesPtr);
    expect(parsedPtr).toBeGreaterThan(0);

    // ParsedObject field order: name(+8), types(+16), imports(+24), functions(+32),
    //   tables(+40), memories(+48), globals(+56), exports(+64), elements(+72),
    //   tags(+80), code(+88), symbols(+96), relocations(+104)
    const dv = new DataView(memory.buffer);
    const typesField = dv.getInt32(parsedPtr + 16, true);
    const functionsField = dv.getInt32(parsedPtr + 32, true);
    const exportsField = dv.getInt32(parsedPtr + 64, true);
    const codeField = dv.getInt32(parsedPtr + 88, true);

    // Verify parsed sections are populated
    expect(typesField).toBeGreaterThan(0);
    expect(ex.__arr_len(typesField)).toBeGreaterThan(0);
    expect(functionsField).toBeGreaterThan(0);
    expect(ex.__arr_len(functionsField)).toBeGreaterThan(0);
    expect(exportsField).toBeGreaterThan(0);
    expect(ex.__arr_len(exportsField)).toBeGreaterThan(0);
    expect(codeField).toBeGreaterThan(0);
    expect(ex.__arr_len(codeField)).toBeGreaterThan(0);
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

    // Build and instantiate linker.wasm
    const wasmBinary = buildLinkerWasm();
    const { instance } = await WebAssembly.instantiate(wasmBinary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(16);
    const ex = instance.exports as unknown as Record<string, Function>;

    // Marshal: write .o files and names into scratch area
    let scratch = 262144;

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
    const linkFn = instance.exports.link as (objects: number, options: number) => number;
    const resultPtr = linkFn(mapPtr, 0);

    // Read LinkResult fields
    // Layout: [header 8B][binary i32@+8][wat i32@+16][success f64@+24][errors i32@+32]
    const dv = new DataView(memory.buffer);
    const binaryPtr = dv.getInt32(resultPtr + 8, true);
    const success = dv.getFloat64(resultPtr + 24, true) !== 0;
    expect(success).toBe(true);

    // Read output binary (Uint8Array layout: [header 8B][len:u32 +8][data +12...])
    const outLen = dv.getUint32(binaryPtr + 8, true);
    const outBytes = new Uint8Array(memory.buffer).slice(binaryPtr + 12, binaryPtr + 12 + outLen);

    // Byte-for-byte match with TypeScript linker
    expect(outBytes).toEqual(tsResult.binary);
  });
});
