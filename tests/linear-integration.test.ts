import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("linear-memory integration", { timeout: 30_000 }, () => {
  it("compiles a LEB128 decoder (linker-like code)", async () => {
    const result = compile(`
      class ByteReader {
        data: number[];
        pos: number;
        constructor(data: number[]) {
          this.data = data;
          this.pos = 0;
        }
        get remaining(): number {
          return this.data.length - this.pos;
        }
        byte(): number {
          const b = this.data[this.pos];
          this.pos = this.pos + 1;
          return b;
        }
        u32(): number {
          let result = 0;
          let shift = 0;
          let b = 0;
          do {
            b = this.byte();
            result = result | ((b & 0x7f) << shift);
            shift = shift + 7;
          } while ((b & 0x80) !== 0);
          return result;
        }
      }

      export function decodeLEB(a: number, b: number): number {
        const reader = new ByteReader([a, b]);
        return reader.u32();
      }

      export function remaining(a: number, b: number, c: number): number {
        const reader = new ByteReader([a, b, c]);
        reader.byte();
        return reader.remaining;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const { decodeLEB, remaining } = instance.exports as any;

    // 0x80, 0x01 = 128 in LEB128
    expect(decodeLEB(0x80, 0x01)).toBe(128);
    // 0x2a = 42 (single byte, high bit clear)
    expect(decodeLEB(0x2a, 0x00)).toBe(42);
    // 0xe5, 0x8e, 0x26 would be a 3-byte LEB but we pass 2
    // Test remaining getter
    expect(remaining(10, 20, 30)).toBe(2);
  });

  it("compiles a Map-based counter (linker-like pattern)", async () => {
    const result = compile(`
      export function test(): number {
        const counts = new Map<number, number>();
        const items = [1, 2, 1, 3, 2, 1];
        for (const item of items) {
          if (counts.has(item)) {
            counts.set(item, counts.get(item)! + 1);
          } else {
            counts.set(item, 1);
          }
        }
        // item 1 appears 3 times
        return counts.get(1)!;
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as any).test()).toBe(3);
  });

  it("compiles class with field mutation and multiple methods", async () => {
    const result = compile(`
      class Stack {
        items: number[];
        constructor() {
          this.items = [];
        }
        push(val: number): void {
          this.items.push(val);
        }
        pop(): number {
          const len = this.items.length;
          const val = this.items[len - 1];
          return val;
        }
        size(): number {
          return this.items.length;
        }
      }

      export function test(): number {
        const s = new Stack();
        s.push(10);
        s.push(20);
        s.push(30);
        const top = s.pop();
        return top + s.size();
      }
    `, { target: "linear" });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    // top=30, size=3 → 33
    expect((instance.exports as any).test()).toBe(33);
  });
});
