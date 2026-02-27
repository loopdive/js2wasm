import { describe, it, expect } from "vitest";
import { WasmEncoder } from "../src/emit/encoder.js";

describe("WasmEncoder", () => {
  it("encodes unsigned LEB128", () => {
    const enc = new WasmEncoder();
    enc.u32(0);
    expect(enc.finish()).toEqual(new Uint8Array([0x00]));
  });

  it("encodes unsigned LEB128 multibyte", () => {
    const enc = new WasmEncoder();
    enc.u32(624485);
    expect(enc.finish()).toEqual(new Uint8Array([0xe5, 0x8e, 0x26]));
  });

  it("encodes signed LEB128 positive", () => {
    const enc = new WasmEncoder();
    enc.i32(42);
    expect(enc.finish()).toEqual(new Uint8Array([0x2a]));
  });

  it("encodes signed LEB128 negative", () => {
    const enc = new WasmEncoder();
    enc.i32(-1);
    expect(enc.finish()).toEqual(new Uint8Array([0x7f]));
  });

  it("encodes f64", () => {
    const enc = new WasmEncoder();
    enc.f64(1.0);
    const result = enc.finish();
    expect(result.length).toBe(8);
    // IEEE 754 for 1.0: 0x3FF0000000000000
    expect(result[7]).toBe(0x3f);
    expect(result[6]).toBe(0xf0);
  });

  it("encodes name (string with length prefix)", () => {
    const enc = new WasmEncoder();
    enc.name("hello");
    const result = enc.finish();
    expect(result[0]).toBe(5); // length
    expect(result[1]).toBe(0x68); // 'h'
    expect(result[2]).toBe(0x65); // 'e'
    expect(result[3]).toBe(0x6c); // 'l'
    expect(result[4]).toBe(0x6c); // 'l'
    expect(result[5]).toBe(0x6f); // 'o'
  });

  it("encodes section", () => {
    const enc = new WasmEncoder();
    enc.section(1, (s) => {
      s.byte(0x42);
    });
    const result = enc.finish();
    expect(result[0]).toBe(1); // section id
    expect(result[1]).toBe(1); // content length
    expect(result[2]).toBe(0x42); // content
  });

  it("encodes vector", () => {
    const enc = new WasmEncoder();
    enc.vector([1, 2, 3], (item, e) => e.byte(item));
    const result = enc.finish();
    expect(result[0]).toBe(3); // count
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(2);
    expect(result[3]).toBe(3);
  });
});
