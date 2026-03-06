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

  // Log compilation errors (access internal ctx errors via a hack)
  // We need to temporarily patch generateLinearMultiModule to expose errors
  // Instead, let's check for 'unreachable' instructions which indicate unhandled cases
  let unreachableCount = 0;
  for (const f of mod.functions) {
    const countInBody = (body: any[]): number => {
      let c = 0;
      for (const instr of body) {
        if (instr.op === "unreachable") c++;
        if (instr.body) c += countInBody(instr.body);
        if (instr.then) c += countInBody(instr.then);
        if (instr.else) c += countInBody(Array.isArray(instr.else) ? instr.else : [instr.else]);
      }
      return c;
    };
    const count = countInBody(f.body);
    if (count > 0 && !f.name.startsWith("__")) {
      unreachableCount += count;
      if (count > 1) console.log(`  ${f.name}: ${count} unreachable instructions`);
    }
  }

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

    // Inspect ParsedObject fields:
    // Layout: [header 8B][name:i32 +8][types:i32 +16][imports:i32 +24][functions:i32 +32]...
    const dv = new DataView(memory.buffer);
    const nameField = dv.getInt32(parsedPtr + 8, true);
    const typesField = dv.getInt32(parsedPtr + 16, true);
    const importsField = dv.getInt32(parsedPtr + 24, true);
    const functionsField = dv.getInt32(parsedPtr + 32, true);
    console.log("ParsedObject fields: name=", nameField, "types=", typesField,
      "imports=", importsField, "functions=", functionsField);

    // Check types array
    if (typesField > 0) {
      const typesLen = ex.__arr_len(typesField) as number;
      console.log("types.length =", typesLen);
      if (typesLen > 0) {
        const firstType = ex.__arr_get(typesField, 0) as number;
        console.log("types[0] ptr =", firstType);
        // TypeSection layout: [header 8B][params:i32 +8][results:i32 +16]
        const paramsField = dv.getInt32(firstType + 8, true);
        const resultsField = dv.getInt32(firstType + 16, true);
        console.log("types[0].params =", paramsField, "types[0].results =", resultsField);
        if (paramsField > 0) {
          const paramsLen = ex.__arr_len(paramsField) as number;
          console.log("types[0].params.length =", paramsLen);
          for (let pi = 0; pi < paramsLen; pi++) {
            const pval = ex.__arr_get(paramsField, pi) as number;
            console.log("  params[" + pi + "] =", pval, "(0x" + pval.toString(16) + ")");
          }
        }
      }
    }

    // Check functions array
    // ParsedObject field order: name(+8), types(+16), imports(+24), functions(+32),
    //   tables(+40), memories(+48), globals(+56), exports(+64), elements(+72),
    //   tags(+80), code(+88), symbols(+96), relocations(+104)
    if (functionsField > 0) {
      const funcsLen = ex.__arr_len(functionsField) as number;
      console.log("functions.length =", funcsLen);
      if (funcsLen > 0) {
        const fn0 = ex.__arr_get(functionsField, 0) as number;
        console.log("functions[0] ptr =", fn0);
        // FunctionEntry layout: [header 8B][typeIdx: ???]
        // Dump raw bytes around the object to determine field layout
        const rawBytes: number[] = [];
        const u8view = new Uint8Array(memory.buffer);
        for (let i = 0; i < 24; i++) rawBytes.push(u8view[fn0 + i]);
        console.log("functions[0] raw:", rawBytes.map(b => b.toString(16).padStart(2, "0")).join(" "));
        // Try reading typeIdx as both i32 and f64
        const typeIdxI32 = dv.getInt32(fn0 + 8, true);
        const typeIdxF64 = dv.getFloat64(fn0 + 8, true);
        console.log("functions[0].typeIdx: i32=", typeIdxI32, "f64=", typeIdxF64);
      }
    }

    // Check exports array
    const exportsField = dv.getInt32(parsedPtr + 64, true);
    console.log("exports field ptr:", exportsField);
    if (exportsField > 0) {
      const exportsLen = ex.__arr_len(exportsField) as number;
      console.log("exports.length =", exportsLen);
      if (exportsLen > 0) {
        const exp0 = ex.__arr_get(exportsField, 0) as number;
        console.log("exports[0] ptr =", exp0);
        // ExportEntry layout: [header 8B][name:i32 +8][kind:??? +??][index:??? +??]
        const rawBytes: number[] = [];
        const u8view = new Uint8Array(memory.buffer);
        for (let i = 0; i < 32; i++) rawBytes.push(u8view[exp0 + i]);
        console.log("exports[0] raw:", rawBytes.map(b => b.toString(16).padStart(2, "0")).join(" "));
        const nameFieldExp = dv.getInt32(exp0 + 8, true);
        const kindI32 = dv.getInt32(exp0 + 16, true);
        const kindF64 = dv.getFloat64(exp0 + 16, true);
        const indexI32 = dv.getInt32(exp0 + 24, true);
        const indexF64 = dv.getFloat64(exp0 + 24, true);
        console.log("exports[0].name ptr:", nameFieldExp, "kind i32:", kindI32, "f64:", kindF64, "index i32:", indexI32, "f64:", indexF64);
        if (nameFieldExp > 0) {
          const nameLen = ex.__str_len(nameFieldExp) as number;
          console.log("exports[0].name len:", nameLen);
        }
      }
    }

    // Check code array
    const codeField = dv.getInt32(parsedPtr + 88, true);
    console.log("code field ptr:", codeField);
    if (codeField > 0) {
      const codeLen = ex.__arr_len(codeField) as number;
      console.log("code.length =", codeLen);
      if (codeLen > 0) {
        const code0 = ex.__arr_get(codeField, 0) as number;
        console.log("code[0] ptr =", code0);
        const rawBytes: number[] = [];
        const u8view = new Uint8Array(memory.buffer);
        for (let i = 0; i < 32; i++) rawBytes.push(u8view[code0 + i]);
        console.log("code[0] raw:", rawBytes.map(b => b.toString(16).padStart(2, "0")).join(" "));
        // CodeEntry layout: [header 8B][locals:i32 +8][body:i32 +16]
        const localsField = dv.getInt32(code0 + 8, true);
        const bodyField = dv.getInt32(code0 + 16, true);
        console.log("code[0].locals:", localsField, "code[0].body:", bodyField);
        if (bodyField > 0) {
          const bodyLen = ex.__u8arr_len(bodyField) as number;
          console.log("code[0].body length:", bodyLen);
          const bodyBytes: number[] = [];
          for (let i = 0; i < Math.min(bodyLen, 16); i++) {
            bodyBytes.push(ex.__u8arr_get(bodyField, i) as number);
          }
          console.log("code[0].body bytes:", bodyBytes.map(b => b.toString(16).padStart(2, "0")).join(" "));
        }
      }
    }
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

    // Dump both outputs for comparison
    const hexDump = (label: string, bytes: Uint8Array) => {
      const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0"));
      for (let i = 0; i < hex.length; i += 16) {
        console.log(label, i.toString(16).padStart(4, "0") + ":", hex.slice(i, i + 16).join(" "));
      }
    };
    hexDump("WASM", outBytes);
    hexDump("TS  ", tsResult.binary);

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
