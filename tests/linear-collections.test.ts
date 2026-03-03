import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile with linear-memory backend and instantiate */
async function compileLinear(source: string) {
  const result = compile(source, { target: "linear" });
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, Function>;
}

describe("linear-memory collections from TS", () => {
  it("compiles array literal and push/index", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const arr: number[] = [];
        arr.push(10);
        arr.push(20);
        arr.push(30);
        return arr[1];
      }
    `);
    expect(e.test()).toBe(20);
  }, 60000);

  it("compiles array.length", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const arr: number[] = [];
        arr.push(1);
        arr.push(2);
        arr.push(3);
        return arr.length;
      }
    `);
    expect(e.test()).toBe(3);
  }, 60000);

  it("compiles array literal with elements", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const arr = [10, 20, 30];
        return arr[0] + arr[2];
      }
    `);
    expect(e.test()).toBe(40);
  }, 60000);

  it("compiles Map operations", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const map = new Map<number, number>();
        map.set(1, 10);
        map.set(2, 20);
        const a = map.get(1)!;
        const b = map.get(2)!;
        return a + b + map.size;
      }
    `);
    expect(e.test()).toBe(32); // 10 + 20 + 2
  }, 60000);

  it("compiles Set operations", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const s = new Set<number>();
        s.add(1);
        s.add(2);
        s.add(3);
        s.add(2); // duplicate
        return s.size;
      }
    `);
    expect(e.test()).toBe(3);
  }, 60000);

  it("compiles Uint8Array create and access", async () => {
    const e = await compileLinear(`
      export function test(): number {
        const buf = new Uint8Array(10);
        buf[0] = 42;
        buf[1] = 100;
        return buf[0] + buf[1];
      }
    `);
    expect(e.test()).toBe(142);
  }, 60000);
});
