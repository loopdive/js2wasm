import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

const SIMPLE_SOURCE = `
  export function add(a: number, b: number): number {
    return a + b;
  }
`;

describe("emitWat option (#693)", () => {
  it("emits WAT by default", () => {
    const result = compile(SIMPLE_SOURCE);
    expect(result.success).toBe(true);
    expect(result.wat).toBeTruthy();
    expect(result.wat).toContain("func");
  });

  it("emits WAT when emitWat: true", () => {
    const result = compile(SIMPLE_SOURCE, { emitWat: true });
    expect(result.success).toBe(true);
    expect(result.wat).toBeTruthy();
  });

  it("skips WAT when emitWat: false", () => {
    const result = compile(SIMPLE_SOURCE, { emitWat: false });
    expect(result.success).toBe(true);
    expect(result.wat).toBe("");
    // Binary should still be valid
    expect(result.binary.length).toBeGreaterThan(0);
  });

  it("produces valid binary with emitWat: false", async () => {
    const result = compile(SIMPLE_SOURCE, { emitWat: false });
    expect(result.success).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: {},
      "wasm:js-string": {
        concat: (a: string, b: string) => a + b,
        length: (s: string) => s.length,
        equals: (a: string, b: string) => (a === b ? 1 : 0),
        substring: (s: string, start: number, end: number) => s.substring(start, end),
        charCodeAt: (s: string, i: number) => s.charCodeAt(i),
      },
      string_constants: buildStringConstants(result.stringPool),
    } as WebAssembly.Imports);

    expect((instance.exports as any).add(2, 3)).toBe(5);
  });
});
