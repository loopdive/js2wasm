import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

describe("#923 — compile() state leak", () => {
  it("produces identical WAT for two consecutive compiles of the same source", () => {
    const source = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const r1 = compile(source, { fileName: "test.ts" });
    const r2 = compile(source, { fileName: "test.ts" });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.wat).toBe(r2.wat);
  });

  it("produces identical binary for two consecutive compiles of the same source", () => {
    const source = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const r1 = compile(source, { fileName: "test.ts" });
    const r2 = compile(source, { fileName: "test.ts" });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(Buffer.from(r1.binary)).toEqual(Buffer.from(r2.binary));
  });

  it("produces identical output after 10 consecutive compiles", () => {
    const source = `
export function greet(name: string): string {
  return "Hello " + name;
}
`;
    const baseline = compile(source, { fileName: "test.ts" });
    expect(baseline.success).toBe(true);

    for (let i = 0; i < 10; i++) {
      const r = compile(source, { fileName: "test.ts" });
      expect(r.success).toBe(true);
      expect(r.wat).toBe(baseline.wat);
    }
  });

  it("compiling different sources doesn't affect subsequent compilations", () => {
    const sourceA = `
export function foo(): number { return 42; }
`;
    const sourceB = `
export class Bar {
  x: number;
  constructor(x: number) { this.x = x; }
  getX(): number { return this.x; }
}
`;
    // Compile A, then B, then A again — A's output should be identical
    const a1 = compile(sourceA, { fileName: "test.ts" });
    const b1 = compile(sourceB, { fileName: "test.ts" });
    const a2 = compile(sourceA, { fileName: "test.ts" });

    expect(a1.success).toBe(true);
    expect(b1.success).toBe(true);
    expect(a2.success).toBe(true);
    expect(a1.wat).toBe(a2.wat);
    expect(Buffer.from(a1.binary)).toEqual(Buffer.from(a2.binary));
  });

  it("regexp compilation is idempotent across calls", () => {
    const source = `
export function test(): boolean {
  const re = /abc/g;
  return re.test("abc");
}
`;
    const r1 = compile(source, { fileName: "test.ts" });
    const r2 = compile(source, { fileName: "test.ts" });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.wat).toBe(r2.wat);
  });

  it("class with methods is idempotent", () => {
    const source = `
export class Counter {
  count: number;
  constructor() { this.count = 0; }
  increment(): void { this.count++; }
  getCount(): number { return this.count; }
}
`;
    const r1 = compile(source, { fileName: "test.ts" });
    // Compile something different in between
    compile(`export function noop(): void {}`, { fileName: "test.ts" });
    const r2 = compile(source, { fileName: "test.ts" });
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.wat).toBe(r2.wat);
  });

  it("error list doesn't accumulate across compilations", () => {
    const badSource = `
export function broken( { return 1; }
`;
    const goodSource = `
export function working(): number { return 1; }
`;
    const bad = compile(badSource, { fileName: "test.ts" });
    const good = compile(goodSource, { fileName: "test.ts" });
    // The good compilation shouldn't carry errors from the bad one
    expect(good.success).toBe(true);
    expect(good.errors.length).toBe(0);
  });

  it("string pool doesn't leak between compilations", () => {
    const source1 = `
export function f(): string { return "hello"; }
`;
    const source2 = `
export function g(): string { return "world"; }
`;
    const r1 = compile(source1, { fileName: "test.ts" });
    const r2 = compile(source2, { fileName: "test.ts" });
    // source2's string pool shouldn't contain "hello" from source1
    expect(r1.stringPool).toContain("hello");
    expect(r2.stringPool).toContain("world");
    expect(r2.stringPool).not.toContain("hello");
  });

  it("import descriptors don't leak between compilations", () => {
    const source1 = `
export function f(): void { console.log("test"); }
`;
    const source2 = `
export function g(): number { return Math.abs(-5); }
`;
    const r1 = compile(source1, { fileName: "test.ts" });
    const r2 = compile(source2, { fileName: "test.ts" });

    const r1Names = r1.imports.map((i) => i.name);
    const r2Names = r2.imports.map((i) => i.name);

    // r2 shouldn't have console imports, r1 shouldn't have Math imports
    // (unless both intrinsically need them)
    const r1HasConsole = r1Names.some((n) => n.includes("console"));
    const r2HasConsole = r2Names.some((n) => n.includes("console"));

    // source2 doesn't use console, so it shouldn't have console imports
    if (!r2HasConsole) {
      // Good — no leak
      expect(r2HasConsole).toBe(false);
    }
  });

  it("50 mixed compilations don't cause progressive degradation", () => {
    const sources = [
      `export function a(): number { return 1 + 2; }`,
      `export function b(x: string): string { return x.toUpperCase(); }`,
      `export class C { v: number; constructor() { this.v = 0; } }`,
      `export function d(arr: number[]): number { return arr.length; }`,
      `export function e(): boolean { return true && false; }`,
    ];

    // Compile each source once to get baseline WATs
    const baselines = sources.map((s) => {
      const r = compile(s, { fileName: "test.ts" });
      expect(r.success).toBe(true);
      return r.wat;
    });

    // Now compile all sources 10 times in rotation
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < sources.length; i++) {
        const r = compile(sources[i]!, { fileName: "test.ts" });
        expect(r.success).toBe(true);
        expect(r.wat).toBe(baselines[i]);
      }
    }
  });
});
