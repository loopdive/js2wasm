import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { encodeVLQ, decodeVLQ, decodeMappings, generateSourceMap } from "../src/emit/sourcemap.js";
import type { SourceMapV3 } from "../src/emit/sourcemap.js";
import type { SourceMapEntry } from "../src/emit/binary.js";

describe("VLQ encoding", () => {
  it("encodes 0", () => {
    expect(encodeVLQ(0)).toBe("A");
  });

  it("encodes positive values", () => {
    expect(encodeVLQ(1)).toBe("C");
    expect(encodeVLQ(5)).toBe("K");
    expect(encodeVLQ(15)).toBe("e");
  });

  it("encodes negative values", () => {
    expect(encodeVLQ(-1)).toBe("D");
    expect(encodeVLQ(-5)).toBe("L");
  });

  it("encodes large values (multi-byte)", () => {
    const encoded = encodeVLQ(100);
    expect(encoded.length).toBeGreaterThan(1);
  });

  it("round-trips correctly", () => {
    for (const value of [0, 1, -1, 5, -5, 15, -15, 100, -100, 1000, -1000]) {
      const encoded = encodeVLQ(value);
      const decoded = decodeVLQ(encoded);
      expect(decoded.value).toBe(value);
      expect(decoded.rest).toBe("");
    }
  });
});

describe("source map generation (unit)", () => {
  it("generates valid source map from entries", () => {
    const entries: SourceMapEntry[] = [
      { wasmOffset: 10, sourcePos: { file: "test.ts", line: 0, column: 0 } },
      { wasmOffset: 20, sourcePos: { file: "test.ts", line: 2, column: 4 } },
      { wasmOffset: 30, sourcePos: { file: "test.ts", line: 5, column: 0 } },
    ];

    const sourceMap = generateSourceMap(entries);

    expect(sourceMap.version).toBe(3);
    expect(sourceMap.sources).toEqual(["test.ts"]);
    expect(sourceMap.names).toEqual([]);
    expect(sourceMap.mappings).toBeTruthy();
  });

  it("includes sourcesContent when provided", () => {
    const entries: SourceMapEntry[] = [
      { wasmOffset: 10, sourcePos: { file: "test.ts", line: 0, column: 0 } },
    ];

    const content = new Map([["test.ts", "const x = 1;"]]);
    const sourceMap = generateSourceMap(entries, content);

    expect(sourceMap.sourcesContent).toEqual(["const x = 1;"]);
  });

  it("handles multiple source files", () => {
    const entries: SourceMapEntry[] = [
      { wasmOffset: 10, sourcePos: { file: "a.ts", line: 0, column: 0 } },
      { wasmOffset: 20, sourcePos: { file: "b.ts", line: 5, column: 2 } },
      { wasmOffset: 30, sourcePos: { file: "a.ts", line: 10, column: 0 } },
    ];

    const sourceMap = generateSourceMap(entries);

    expect(sourceMap.sources).toEqual(["a.ts", "b.ts"]);
  });

  it("handles empty entries", () => {
    const sourceMap = generateSourceMap([]);

    expect(sourceMap.version).toBe(3);
    expect(sourceMap.sources).toEqual([]);
    expect(sourceMap.mappings).toBe("");
  });

  it("mappings decode to valid values", () => {
    const entries: SourceMapEntry[] = [
      { wasmOffset: 10, sourcePos: { file: "test.ts", line: 0, column: 0 } },
      { wasmOffset: 25, sourcePos: { file: "test.ts", line: 3, column: 4 } },
    ];

    const sourceMap = generateSourceMap(entries);
    const decoded = decodeMappings(sourceMap.mappings);

    // All mappings are in a single group (wasm convention)
    expect(decoded.length).toBe(1);
    const segments = decoded[0]!;
    expect(segments.length).toBe(2);

    // First segment: [wasmOffset=10, sourceIdx=0, line=0, col=0]
    expect(segments[0]!).toEqual([10, 0, 0, 0]);

    // Second segment: [wasmOffsetDelta=15, sourceIdxDelta=0, lineDelta=3, colDelta=4]
    expect(segments[1]!).toEqual([15, 0, 3, 4]);
  });
});

describe("source map integration", () => {
  it("generates source map when option is enabled", () => {
    const result = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
      { sourceMap: true },
    );

    expect(result.success).toBe(true);
    expect(result.sourceMap).toBeDefined();

    const sourceMap = JSON.parse(result.sourceMap!) as SourceMapV3;
    expect(sourceMap.version).toBe(3);
    expect(sourceMap.sources.length).toBeGreaterThan(0);
    expect(sourceMap.mappings.length).toBeGreaterThan(0);
  });

  it("does not generate source map when option is not set", () => {
    const result = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
    );

    expect(result.success).toBe(true);
    expect(result.sourceMap).toBeUndefined();
  });

  it("source map contains correct source file name", () => {
    const result = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
      { sourceMap: true, moduleName: "mymodule.ts" },
    );

    expect(result.success).toBe(true);
    const sourceMap = JSON.parse(result.sourceMap!) as SourceMapV3;
    expect(sourceMap.sources).toContain("mymodule.ts");
  });

  it("source map has valid mappings that decode", () => {
    const result = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
      { sourceMap: true },
    );

    expect(result.success).toBe(true);
    const sourceMap = JSON.parse(result.sourceMap!) as SourceMapV3;

    // Decode the mappings
    const decoded = decodeMappings(sourceMap.mappings);

    // Should have at least one group with at least one segment
    expect(decoded.length).toBeGreaterThan(0);
    const allSegments = decoded.flat();
    expect(allSegments.length).toBeGreaterThan(0);

    // Each segment should have 4 values: [genCol, srcIdx, srcLine, srcCol]
    for (const segment of allSegments) {
      expect(segment.length).toBe(4);
      // Source index should be valid
      const srcIdx = segment[1]!;
      // Accumulate source indices to check they stay within bounds
      // (since they're delta-encoded, we just verify the segment has 4 fields)
      expect(typeof srcIdx).toBe("number");
    }
  });

  it("source map contains sourcesContent when sourceMap is enabled", () => {
    const source = `export function greet(): number { return 42; }`;
    const result = compile(source, { sourceMap: true });

    expect(result.success).toBe(true);
    const sourceMap = JSON.parse(result.sourceMap!) as SourceMapV3;
    expect(sourceMap.sourcesContent.length).toBe(sourceMap.sources.length);
    // At least one source should have content
    expect(sourceMap.sourcesContent.some((c) => c !== null)).toBe(true);
  });

  it("binary contains sourceMappingURL custom section when sourceMap enabled", () => {
    const result = compile(
      `export function foo(): number { return 1; }`,
      { sourceMap: true, sourceMapUrl: "test.wasm.map" },
    );

    expect(result.success).toBe(true);

    // Search for the sourceMappingURL string in the binary
    const binary = result.binary;
    const textDecoder = new TextDecoder();
    const binaryStr = textDecoder.decode(binary);
    expect(binaryStr).toContain("sourceMappingURL");
    expect(binaryStr).toContain("test.wasm.map");
  });

  it("binary is still valid wasm when sourceMap is enabled", async () => {
    const result = compile(
      `export function add(a: number, b: number): number { return a + b; }`,
      { sourceMap: true },
    );

    expect(result.success).toBe(true);

    // Validate the binary by compiling it
    const wasmModule = await WebAssembly.compile(result.binary);
    expect(wasmModule).toBeTruthy();

    // Also instantiate and run
    const { instance } = await WebAssembly.instantiate(result.binary);
    const add = instance.exports.add as (a: number, b: number) => number;
    expect(add(2, 3)).toBe(5);
  });

  it("source map line numbers point to valid source locations", () => {
    const source = [
      "export function compute(x: number): number {",
      "  const y = x * 2;",
      "  return y + 1;",
      "}",
    ].join("\n");

    const result = compile(source, { sourceMap: true });
    expect(result.success).toBe(true);

    const sourceMap = JSON.parse(result.sourceMap!) as SourceMapV3;
    const decoded = decodeMappings(sourceMap.mappings);
    const allSegments = decoded.flat();

    // Reconstruct absolute positions from delta-encoded values
    let absLine = 0;
    let absSrcIdx = 0;
    const sourceLines = source.split("\n");

    for (const segment of allSegments) {
      absSrcIdx += segment[1]!;
      absLine += segment[2]!;

      // Line should be within the source
      expect(absLine).toBeGreaterThanOrEqual(0);
      expect(absLine).toBeLessThan(sourceLines.length);
    }
  });
});
