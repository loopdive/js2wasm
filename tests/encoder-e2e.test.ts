import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { analyzeMultiSource } from "../src/checker/index.js";
import { generateLinearMultiModule } from "../src/codegen-linear/index.js";
import { emitBinary } from "../src/emit/binary.js";

describe("encoder e2e", { timeout: 60_000 }, () => {
  it("section() writes correct bytes", async () => {
    // Minimal test: compile just the encoder and a function that uses section()
    const source = `
export class WasmEncoder {
  private buf: number[] = [];
  byte(b: number): void { this.buf.push(b & 0xff); }
  u32(value: number): void {
    do {
      let b = value & 0x7f;
      value >>>= 7;
      if (value !== 0) b |= 0x80;
      this.byte(b);
    } while (value !== 0);
  }
  section(id: number, content: (enc: WasmEncoder) => void): void {
    const sub = new WasmEncoder();
    content(sub);
    const data = sub.finish();
    this.byte(id);
    this.u32(data.length);
    this.bytes(data);
  }
  bytes(bs: Uint8Array): void { for (let i = 0; i < bs.length; i++) this.byte(bs[i]!); }
  finish(): Uint8Array { return new Uint8Array(this.buf); }
}

export function testSection(): Uint8Array {
  const enc = new WasmEncoder();
  enc.section(1, (s) => {
    s.u32(2);
    s.byte(0x60);
  });
  return enc.finish();
}
`;
    const files = { "test.ts": source };
    const multiAst = analyzeMultiSource(files, "test.ts");
    const mod = generateLinearMultiModule(multiAst);

    // Export runtime helpers
    const helpers = ["__malloc", "__arr_new", "__arr_push", "__arr_len", "__arr_get",
      "__u8arr_new", "__u8arr_from_arr", "__u8arr_len", "__u8arr_get",
      "WasmEncoder_ctor", "WasmEncoder_byte", "WasmEncoder_u32", "WasmEncoder_finish",
    ];
    for (const name of helpers) {
      const idx = mod.functions.findIndex(f => f.name === name);
      if (idx >= 0) mod.exports.push({ name, desc: { kind: "func", index: idx } });
    }

    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(4);
    const ex = instance.exports as unknown as Record<string, Function>;

    // Call testSection()
    const resultPtr = (ex.testSection as Function)();
    console.log("testSection returned:", resultPtr);

    // Read result Uint8Array
    const dv = new DataView(memory.buffer);
    const len = dv.getUint32(resultPtr + 8, true);
    const bytes: number[] = [];
    const u8 = new Uint8Array(memory.buffer);
    for (let i = 0; i < len; i++) bytes.push(u8[resultPtr + 12 + i]);
    console.log("result length:", len, "bytes:", bytes.map(b => b.toString(16).padStart(2, '0')).join(' '));

    // Expected: byte(1) = 01, u32(2) = 02 (2 content bytes), content: u32(2)=02 byte(0x60)=60
    // So: 01 02 02 60
    expect(len).toBe(4);
    expect(bytes).toEqual([0x01, 0x02, 0x02, 0x60]);
  });

  it("section() with captured array works", async () => {
    const source = `
export class WasmEncoder {
  private buf: number[] = [];
  byte(b: number): void { this.buf.push(b & 0xff); }
  u32(value: number): void {
    do {
      let b = value & 0x7f;
      value >>>= 7;
      if (value !== 0) b |= 0x80;
      this.byte(b);
    } while (value !== 0);
  }
  section(id: number, content: (enc: WasmEncoder) => void): void {
    const sub = new WasmEncoder();
    content(sub);
    const data = sub.finish();
    this.byte(id);
    this.u32(data.length);
    this.bytes(data);
  }
  bytes(bs: Uint8Array): void { for (let i = 0; i < bs.length; i++) this.byte(bs[i]!); }
  finish(): Uint8Array { return new Uint8Array(this.buf); }
}

export function testCapturedSection(): Uint8Array {
  const enc = new WasmEncoder();
  const items: number[] = [0x7c, 0x7c];
  enc.section(1, (s) => {
    s.u32(items.length);
    for (const item of items) {
      s.byte(item);
    }
  });
  return enc.finish();
}
`;
    const files = { "test.ts": source };
    const multiAst = analyzeMultiSource(files, "test.ts");
    const mod = generateLinearMultiModule(multiAst);

    const helpers = ["__malloc", "__arr_new", "__arr_push", "__arr_len", "__arr_get",
      "__u8arr_new", "__u8arr_from_arr", "__u8arr_len", "__u8arr_get"];
    for (const name of helpers) {
      const idx = mod.functions.findIndex(f => f.name === name);
      if (idx >= 0) mod.exports.push({ name, desc: { kind: "func", index: idx } });
    }

    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(4);
    const ex = instance.exports as unknown as Record<string, Function>;

    const resultPtr = (ex.testCapturedSection as Function)();
    const dv = new DataView(memory.buffer);
    const len = dv.getUint32(resultPtr + 8, true);
    const bytes: number[] = [];
    const u8 = new Uint8Array(memory.buffer);
    for (let i = 0; i < len; i++) bytes.push(u8[resultPtr + 12 + i]);
    console.log("captured section result:", len, "bytes:", bytes.map(b => b.toString(16).padStart(2, '0')).join(' '));

    // Expected: section(1, content) where content = u32(2)=02 byte(0x7c)=7c byte(0x7c)=7c
    // Total content: 3 bytes. So: 01 03 02 7c 7c
    expect(bytes).toEqual([0x01, 0x03, 0x02, 0x7c, 0x7c]);
  });

  it("multiple section() calls work", async () => {
    const source = `
export class WasmEncoder {
  private buf: number[] = [];
  byte(b: number): void { this.buf.push(b & 0xff); }
  u32(value: number): void {
    do {
      let b = value & 0x7f;
      value >>>= 7;
      if (value !== 0) b |= 0x80;
      this.byte(b);
    } while (value !== 0);
  }
  section(id: number, content: (enc: WasmEncoder) => void): void {
    const sub = new WasmEncoder();
    content(sub);
    const data = sub.finish();
    this.byte(id);
    this.u32(data.length);
    this.bytes(data);
  }
  bytes(bs: Uint8Array): void { for (let i = 0; i < bs.length; i++) this.byte(bs[i]!); }
  finish(): Uint8Array { return new Uint8Array(this.buf); }
}

export function testMultiSection(): Uint8Array {
  const enc = new WasmEncoder();
  const types: number[] = [0x7c, 0x7c];
  const funcs: number[] = [0, 1];
  enc.section(1, (s) => {
    s.u32(types.length);
    for (const t of types) s.byte(t);
  });
  enc.section(3, (s) => {
    s.u32(funcs.length);
    for (const f of funcs) s.u32(f);
  });
  return enc.finish();
}
`;
    const files = { "test.ts": source };
    const multiAst = analyzeMultiSource(files, "test.ts");
    const mod = generateLinearMultiModule(multiAst);

    const helpers = ["__malloc", "__arr_new", "__arr_push", "__arr_len", "__arr_get",
      "__u8arr_new", "__u8arr_from_arr", "__u8arr_len", "__u8arr_get"];
    for (const name of helpers) {
      const idx = mod.functions.findIndex(f => f.name === name);
      if (idx >= 0) mod.exports.push({ name, desc: { kind: "func", index: idx } });
    }

    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(4);
    const ex = instance.exports as unknown as Record<string, Function>;

    const resultPtr = (ex.testMultiSection as Function)();
    const dv = new DataView(memory.buffer);
    const len = dv.getUint32(resultPtr + 8, true);
    const bytes: number[] = [];
    const u8 = new Uint8Array(memory.buffer);
    for (let i = 0; i < len; i++) bytes.push(u8[resultPtr + 12 + i]);
    console.log("multi section result:", len, "bytes:", bytes.map(b => b.toString(16).padStart(2, '0')).join(' '));

    // Section 1: content = u32(2) byte(0x7c) byte(0x7c) = 3 bytes
    // Section 3: content = u32(2) u32(0) u32(1) = 3 bytes
    // Total: 01 03 02 7c 7c 03 03 02 00 01
    expect(bytes).toEqual([0x01, 0x03, 0x02, 0x7c, 0x7c, 0x03, 0x03, 0x02, 0x00, 0x01]);
  });
});
