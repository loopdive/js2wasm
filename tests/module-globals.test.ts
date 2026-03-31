import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("module-level globals", () => {
  it("module-level counter shared between functions", async () => {
    const src = `
let counter = 0;

function inc(): void {
  counter = counter + 1;
}

export function main(): number {
  inc();
  inc();
  inc();
  return counter;
}
`;
    const result = compile(src);
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports);
    const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, imports);
    const exports = instance.exports as any;
    expect(exports.main()).toBe(3);
  });

  it("module-level array with push and length", async () => {
    const src = `
let items: number[] = [];

function addItem(v: number): void {
  items.push(v);
}

export function main(): number {
  addItem(10);
  addItem(20);
  addItem(30);
  return items.length;
}
`;
    const result = compile(src);
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports);
    const { instance } = await WebAssembly.instantiate(result.binary as BufferSource, imports);
    const exports = instance.exports as any;
    expect(exports.main()).toBe(3);
  });
});
