import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(code: string): Promise<number> {
  const wrapped = `export function test(): number { ${code} }`;
  const r = compile(wrapped, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as Function)();
}

describe("Issue #1137: ES2023 array methods", () => {
  describe("toReversed", () => {
    it("returns reversed copy", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3];
        const b = a.toReversed();
        return b[0] === 3 && b[1] === 2 && b[2] === 1 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("does not mutate original", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3];
        const b = a.toReversed();
        return a[0] === 1 && b[0] === 3 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("handles empty array", async () => {
      expect(
        await run(`
        const a: number[] = [];
        return a.toReversed().length;
      `),
      ).toBe(0);
    });

    it("handles single element", async () => {
      expect(
        await run(`
        const a: number[] = [42];
        return a.toReversed()[0];
      `),
      ).toBe(42);
    });
  });

  describe("toSorted", () => {
    it("returns sorted copy", async () => {
      expect(
        await run(`
        const a: number[] = [3, 1, 2];
        const b = a.toSorted();
        return b[0] === 1 && b[1] === 2 && b[2] === 3 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("does not mutate original", async () => {
      expect(
        await run(`
        const a: number[] = [3, 1, 2];
        const b = a.toSorted();
        return a[0] === 3 && b[0] === 1 ? 1 : 0;
      `),
      ).toBe(1);
    });
  });

  describe("toSpliced", () => {
    it("deletes elements", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3, 4, 5];
        const b = a.toSpliced(1, 2);
        return b.length === 3 && b[0] === 1 && b[1] === 4 && b[2] === 5 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("inserts elements", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3];
        const b = a.toSpliced(1, 0, 10, 20);
        return b.length === 5 && b[1] === 10 && b[2] === 20 && b[3] === 2 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("replaces elements", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3, 4];
        const b = a.toSpliced(1, 2, 10);
        return b.length === 3 && b[0] === 1 && b[1] === 10 && b[2] === 4 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("does not mutate original", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3];
        const b = a.toSpliced(0, 1);
        return a.length === 3 && b.length === 2 ? 1 : 0;
      `),
      ).toBe(1);
    });
  });

  describe("with", () => {
    it("replaces element at index", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3];
        const b = a.with(1, 99);
        return b[0] === 1 && b[1] === 99 && b[2] === 3 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("does not mutate original", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3];
        const b = a.with(0, 99);
        return a[0] === 1 && b[0] === 99 ? 1 : 0;
      `),
      ).toBe(1);
    });

    it("supports negative index", async () => {
      expect(
        await run(`
        const a: number[] = [1, 2, 3];
        const b = a.with(-1, 99);
        return b[2] === 99 ? 1 : 0;
      `),
      ).toBe(1);
    });
  });
});
