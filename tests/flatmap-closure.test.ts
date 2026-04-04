import { describe, it, expect } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { generateLinearMultiModule } from "../src/codegen-linear/index.js";
import { emitBinary } from "../src/emit/binary.js";

describe("flatMap closure repro", { timeout: 60_000 }, () => {
  it("flatMap on object.field + closure reads correct values", async () => {
    const source = `
interface TypeEntry {
  params: number[];
  results: number[];
}

interface ParsedObj {
  name: string;
  types: TypeEntry[];
}

export class Encoder {
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
  section(id: number, content: (enc: Encoder) => void): void {
    const sub = new Encoder();
    content(sub);
    const data = sub.finish();
    this.byte(id);
    this.u32(data.length);
    this.bytes(data);
  }
  bytes(bs: Uint8Array): void { for (let i = 0; i < bs.length; i++) this.byte(bs[i]!); }
  finish(): Uint8Array { return new Uint8Array(this.buf); }
}

function makeParsed(): ParsedObj[] {
  const t1: TypeEntry = { params: [0x7c, 0x7c], results: [0x7c] };
  const obj1: ParsedObj = { name: "a.o", types: [t1] };
  const t2: TypeEntry = { params: [0x7c, 0x7c], results: [0x7c] };
  const obj2: ParsedObj = { name: "b.o", types: [t2] };
  return [obj1, obj2];
}

export function testTypeSection(): Uint8Array {
  const parsed = makeParsed();
  const allTypes = parsed.flatMap((obj) => obj.types);
  const enc = new Encoder();
  enc.section(1, (s) => {
    s.u32(allTypes.length);
    for (const t of allTypes) {
      s.byte(0x60);
      s.u32(t.params.length);
      for (const p of t.params) s.byte(p);
      s.u32(t.results.length);
      for (const r of t.results) s.byte(r);
    }
  });
  return enc.finish();
}
`;
    const files = { "test.ts": source };
    const multiAst = analyzeMultiSource(files, "test.ts");
    const mod = generateLinearMultiModule(multiAst);

    // Check for compilation errors
    const errors = (mod as any).errors || [];
    if (errors.length > 0) {
      console.log("Compilation errors:", errors);
    }

    const helpers = [
      "__malloc",
      "__arr_new",
      "__arr_push",
      "__arr_len",
      "__arr_get",
      "__u8arr_new",
      "__u8arr_from_arr",
      "__u8arr_len",
      "__u8arr_get",
    ];
    for (const name of helpers) {
      const idx = mod.functions.findIndex((f: any) => f.name === name);
      if (idx >= 0) mod.exports.push({ name, desc: { kind: "func", index: idx } });
    }

    const binary = emitBinary(mod);
    const { instance } = await WebAssembly.instantiate(binary);
    const memory = instance.exports.memory as WebAssembly.Memory;
    memory.grow(4);
    const ex = instance.exports as unknown as Record<string, Function>;

    const resultPtr = (ex.testTypeSection as Function)();
    const dv = new DataView(memory.buffer);
    const len = dv.getUint32(resultPtr + 8, true);
    const bytes: number[] = [];
    const u8 = new Uint8Array(memory.buffer);
    for (let i = 0; i < len; i++) bytes.push(u8[resultPtr + 12 + i]);
    console.log("bytes:", bytes.map((b) => b.toString(16).padStart(2, "0")).join(" "));

    // Expected type section: 01 0d 02 60 02 7c 7c 01 7c 60 02 7c 7c 01 7c
    expect(bytes[0]).toBe(0x01); // section ID
    expect(bytes[1]).toBe(0x0d); // content size = 13
    expect(bytes[2]).toBe(0x02); // count = 2
    expect(bytes[3]).toBe(0x60); // func type marker
    expect(bytes[4]).toBe(0x02); // params count = 2
    expect(bytes[5]).toBe(0x7c); // f64
    expect(bytes[6]).toBe(0x7c); // f64
    expect(bytes[7]).toBe(0x01); // results count = 1
    expect(bytes[8]).toBe(0x7c); // f64
  });
});
