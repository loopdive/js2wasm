/**
 * Issue #973: Verify incremental compiler produces identical output to standalone.
 *
 * Tests that createIncrementalCompiler() does not leak state between compilations.
 * Sequential compilations through the incremental compiler should produce byte-identical
 * Wasm binaries compared to standalone compile() calls.
 */
import { describe, it, expect } from "vitest";
import { compile, createIncrementalCompiler } from "../src/index.ts";

describe("Issue #973 — incremental compiler state isolation", () => {
  it("simple test produces identical output standalone vs incremental", () => {
    const source = `
export function add(a: number, b: number): number {
  return a + b;
}
export function test(): number {
  return add(1, 2);
}
`;
    const opts = { fileName: "test.ts", emitWat: false, skipSemanticDiagnostics: true };
    const standalone = compile(source, opts);
    const incr = createIncrementalCompiler(opts);
    const incremental = incr.compile(source);
    incr.dispose();

    expect(standalone.success).toBe(true);
    expect(incremental.success).toBe(true);
    expect(incremental.binary.length).toBe(standalone.binary.length);
    expect(Buffer.from(incremental.binary)).toEqual(Buffer.from(standalone.binary));
  });

  it("compilation after heavy-type source produces identical output", () => {
    // First compile something with lots of lib types
    const heavySource = `
const d = new Date();
const m = new Map<string, number>();
const s = new Set<number>();
const r = new RegExp("test");
const err = new Error("oops");

async function doAsync(): Promise<string> {
  return "done";
}

export function test(): number {
  return 1;
}
`;

    // Then compile something simple
    const simpleSource = `
export function test(): number {
  return 42;
}
`;

    const opts = { fileName: "test.ts", emitWat: false, skipSemanticDiagnostics: true };

    // Standalone
    const standaloneSimple = compile(simpleSource, opts);

    // Incremental: heavy → simple
    const incr = createIncrementalCompiler(opts);
    incr.compile(heavySource); // compile heavy first
    const incrSimple = incr.compile(simpleSource); // then simple
    incr.dispose();

    expect(standaloneSimple.success).toBe(true);
    expect(incrSimple.success).toBe(true);
    expect(incrSimple.binary.length).toBe(standaloneSimple.binary.length);
    expect(Buffer.from(incrSimple.binary)).toEqual(Buffer.from(standaloneSimple.binary));
  });

  it("class-heavy source does not contaminate subsequent compilation", () => {
    const classSource = `
class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  speak(): string {
    return this.name + " speaks";
  }
}

class Dog extends Animal {
  breed: string;
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
}

export function test(): number {
  const d = new Dog("Rex", "Labrador");
  return d.speak().length > 0 ? 1 : 0;
}
`;

    const numSource = `
export function fib(n: number): number {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
export function test(): number {
  return fib(10) === 55 ? 1 : 0;
}
`;

    const opts = { fileName: "test.ts", emitWat: false, skipSemanticDiagnostics: true };

    const standaloneNum = compile(numSource, opts);

    const incr = createIncrementalCompiler(opts);
    incr.compile(classSource);
    const incrNum = incr.compile(numSource);
    incr.dispose();

    expect(standaloneNum.success).toBe(true);
    expect(incrNum.success).toBe(true);
    expect(incrNum.binary.length).toBe(standaloneNum.binary.length);
    expect(Buffer.from(incrNum.binary)).toEqual(Buffer.from(standaloneNum.binary));
  });

  it("10 sequential compilations produce identical output", () => {
    const sources = [
      `export function test(): number { return 1; }`,
      `export function test(): number { const x: string = "hello"; return x.length; }`,
      `export function test(): number { const arr = [1,2,3]; return arr.length; }`,
      `export function test(): number { let sum = 0; for (let i = 0; i < 10; i++) sum += i; return sum; }`,
      `class Foo { x: number = 42; } export function test(): number { return new Foo().x; }`,
      `async function f(): Promise<number> { return 1; } export function test(): number { return 1; }`,
      `export function test(): number { try { throw new Error("e"); } catch(e) { return 1; } return 0; }`,
      `export function test(): number { const m = new Map<string, number>(); m.set("a", 1); return 1; }`,
      `export function test(): number { const s = new Set<number>(); s.add(1); return s.has(1) ? 1 : 0; }`,
      `export function test(): number { return Math.floor(3.7) === 3 ? 1 : 0; }`,
    ];

    const opts = { fileName: "test.ts", emitWat: false, skipSemanticDiagnostics: true };
    const incr = createIncrementalCompiler(opts);

    for (let i = 0; i < sources.length; i++) {
      const standalone = compile(sources[i]!, opts);
      const incremental = incr.compile(sources[i]!);

      expect(standalone.success).toBe(incremental.success);
      if (standalone.success && incremental.success) {
        expect(incremental.binary.length).toBe(standalone.binary.length);
        expect(Buffer.from(incremental.binary)).toEqual(Buffer.from(standalone.binary));
      }
    }

    incr.dispose();
  });
});
