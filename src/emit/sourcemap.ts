/**
 * Source Map v3 generator for Wasm binaries.
 *
 * Wasm source maps use a slightly different convention than JS source maps:
 * - Each "line" in the generated output corresponds to a single wasm byte offset
 * - The mappings field uses standard Base64 VLQ encoding
 * - Format follows: https://sourcemaps.info/spec.html
 */

import type { SourcePos } from "../ir/types.js";
import type { SourceMapEntry } from "./binary.js";

/** Source map v3 JSON structure */
export interface SourceMapV3 {
  version: 3;
  sources: string[];
  sourcesContent: (string | null)[];
  names: string[];
  mappings: string;
}

// Base64 VLQ encoding characters
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode a signed integer as a Base64 VLQ string */
export function encodeVLQ(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let encoded = "";
  do {
    let digit = vlq & 0x1f; // 5 bits
    vlq >>>= 5;
    if (vlq > 0) {
      digit |= 0x20; // continuation bit
    }
    encoded += BASE64_CHARS[digit];
  } while (vlq > 0);
  return encoded;
}

/** Decode a Base64 VLQ string back to a signed integer (for testing) */
export function decodeVLQ(encoded: string): { value: number; rest: string } {
  let vlq = 0;
  let shift = 0;
  let i = 0;
  let continuation = true;

  while (continuation && i < encoded.length) {
    const char = encoded[i]!;
    const digit = BASE64_CHARS.indexOf(char);
    if (digit === -1) throw new Error(`Invalid VLQ character: ${char}`);
    vlq |= (digit & 0x1f) << shift;
    continuation = (digit & 0x20) !== 0;
    shift += 5;
    i++;
  }

  // Convert from unsigned to signed
  const isNegative = (vlq & 1) === 1;
  const value = vlq >>> 1;

  return {
    value: isNegative ? -value : value,
    rest: encoded.slice(i),
  };
}

/**
 * Decode all VLQ segments from a mappings string.
 * Returns an array of segments, where each segment is an array of decoded values.
 * Groups are separated by semicolons (;) and segments within a group by commas (,).
 */
export function decodeMappings(mappings: string): number[][][] {
  const groups: number[][][] = [];
  const lines = mappings.split(";");

  for (const line of lines) {
    const segments: number[][] = [];
    if (line.length > 0) {
      const parts = line.split(",");
      for (const part of parts) {
        const values: number[] = [];
        let remaining = part;
        while (remaining.length > 0) {
          const { value, rest } = decodeVLQ(remaining);
          values.push(value);
          remaining = rest;
        }
        if (values.length > 0) {
          segments.push(values);
        }
      }
    }
    groups.push(segments);
  }

  return groups;
}

/**
 * Generate a source map from wasm binary emission entries.
 *
 * Each entry maps a wasm byte offset to a source file position.
 * The generated source map uses the wasm-specific convention where
 * each mapping segment is on a separate "line" (separated by ;).
 *
 * @param entries Source map entries from binary emission
 * @param sourcesContent Optional map from file name to source content
 */
export function generateSourceMap(entries: SourceMapEntry[], sourcesContent?: Map<string, string>): SourceMapV3 {
  if (entries.length === 0) {
    return {
      version: 3,
      sources: [],
      sourcesContent: [],
      names: [],
      mappings: "",
    };
  }

  // Sort entries by wasm byte offset
  const sorted = [...entries].sort((a, b) => a.wasmOffset - b.wasmOffset);

  // Build sources array (deduplicated, maintaining order)
  const sourceIndex = new Map<string, number>();
  const sources: string[] = [];
  for (const entry of sorted) {
    if (!sourceIndex.has(entry.sourcePos.file)) {
      sourceIndex.set(entry.sourcePos.file, sources.length);
      sources.push(entry.sourcePos.file);
    }
  }

  // Build sourcesContent array
  const contentArray: (string | null)[] = sources.map((s) => sourcesContent?.get(s) ?? null);

  // Generate mappings using Wasm source map convention.
  // For Wasm, each mapping segment contains:
  //   [wasmByteOffset, sourceIdx, sourceLine, sourceCol]
  // All values are relative (delta-encoded from previous values).
  // Segments are separated by commas, and there's a single "group" (no semicolons needed
  // since wasm doesn't have line-based structure).
  let prevWasmOffset = 0;
  let prevSourceIdx = 0;
  let prevSourceLine = 0;
  let prevSourceCol = 0;

  const segments: string[] = [];

  for (const entry of sorted) {
    const srcIdx = sourceIndex.get(entry.sourcePos.file)!;

    const wasmDelta = entry.wasmOffset - prevWasmOffset;
    const srcIdxDelta = srcIdx - prevSourceIdx;
    const lineDelta = entry.sourcePos.line - prevSourceLine;
    const colDelta = entry.sourcePos.column - prevSourceCol;

    // Encode segment: [generatedColumn, sourceIdx, sourceLine, sourceColumn]
    // In wasm source maps, "generatedColumn" represents the wasm byte offset delta
    const segment = encodeVLQ(wasmDelta) + encodeVLQ(srcIdxDelta) + encodeVLQ(lineDelta) + encodeVLQ(colDelta);

    segments.push(segment);

    prevWasmOffset = entry.wasmOffset;
    prevSourceIdx = srcIdx;
    prevSourceLine = entry.sourcePos.line;
    prevSourceCol = entry.sourcePos.column;
  }

  // Wasm source maps put all mappings in a single line (no semicolons)
  const mappings = segments.join(",");

  return {
    version: 3,
    sources,
    sourcesContent: contentArray,
    names: [],
    mappings,
  };
}
