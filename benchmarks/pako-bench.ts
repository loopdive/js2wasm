/**
 * pako (zlib) benchmark: js2wasm Wasm vs JS
 *
 * pako is a pure-JS zlib implementation. Its full source uses patterns js2wasm
 * cannot yet compile (classes, require(), untyped object property access,
 * labeled break across nested loops, Uint32Array constructor, etc.).
 *
 * This benchmark extracts the core compute-intensive kernels from pako as clean
 * TypeScript and compiles them to Wasm via js2wasm, then benchmarks against
 * equivalent JS implementations.
 *
 * Each kernel is self-contained: it generates test data internally, runs the
 * algorithm, and returns a checksum. This avoids JS-to-Wasm array marshalling
 * issues with WasmGC arrays in gc-native mode.
 *
 * Kernels extracted:
 *   1. Adler32 checksum  (12% of inflate time at level 0)
 *   2. CRC32 checksum    (used for gzip verification)
 *   3. LZ77 match finder (core of deflate compression)
 *   4. Huffman bit reader (core of inflate decompression)
 *
 * Run: npx tsx benchmarks/pako-bench.ts
 */

import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// ---------------------------------------------------------------------------
// Self-contained TypeScript sources for js2wasm compilation.
// Each exports a run() function that builds data internally and returns a result.
// ---------------------------------------------------------------------------

function makeAdler32Source(dataSize: number): string {
  return `
export function run(): number {
  // Generate ${dataSize} bytes of semi-compressible test data
  const buf: number[] = [];
  for (let i = 0; i < ${dataSize}; i++) {
    if (i % 7 === 0) {
      buf.push(72);
    } else if (i % 11 === 0) {
      buf.push(101);
    } else {
      buf.push((i * 31 + 17) & 255);
    }
  }

  // Adler32 checksum (from pako/lib/zlib/adler32.js)
  let s1 = 1;
  let s2 = 0;
  let pos = 0;
  let n = 0;
  let len = ${dataSize};

  while (len !== 0) {
    n = len > 2000 ? 2000 : len;
    len = len - n;
    do {
      s1 = s1 + buf[pos];
      pos = pos + 1;
      s2 = s2 + s1;
      n = n - 1;
    } while (n > 0);
    s1 = s1 % 65521;
    s2 = s2 % 65521;
  }

  return s1 + s2 * 65536;
}
`;
}

function makeCrc32Source(dataSize: number): string {
  return `
export function run(): number {
  // Build CRC32 lookup table (from pako/lib/zlib/crc32.js)
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c: number = n;
    for (let k = 0; k < 8; k++) {
      if ((c & 1) !== 0) {
        c = (c >>> 1) ^ 3988292384;
      } else {
        c = c >>> 1;
      }
    }
    table.push(c);
  }

  // Generate ${dataSize} bytes of test data
  const buf: number[] = [];
  for (let i = 0; i < ${dataSize}; i++) {
    if (i % 7 === 0) {
      buf.push(72);
    } else if (i % 11 === 0) {
      buf.push(101);
    } else {
      buf.push((i * 31 + 17) & 255);
    }
  }

  // CRC32 checksum
  let crc: number = -1;
  for (let i = 0; i < ${dataSize}; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 255];
  }
  return crc ^ (-1);
}
`;
}

function makeLz77Source(windowSize: number): string {
  return `
export function run(): number {
  // Generate window data with repeating patterns
  const win: number[] = [];
  for (let i = 0; i < ${windowSize}; i++) {
    win.push((i * 7 + 3) & 255);
  }

  // Generate lookahead that partially matches window
  const lookahead: number[] = [];
  const matchStart = ${windowSize} - 50;
  for (let i = 0; i < 64; i++) {
    if (i < 30) {
      lookahead.push(win[matchStart + i]);
    } else {
      lookahead.push((i * 13 + 5) & 255);
    }
  }

  // LZ77-style longest match finder (core of deflate)
  const maxDist = ${Math.min(windowSize, 256)};
  const maxLen = 258;
  let bestLen = 0;
  let bestDist = 0;

  for (let dist = 1; dist <= maxDist && dist <= ${windowSize}; dist++) {
    let len = 0;
    const start = ${windowSize} - dist;
    while (len < 64 && len < maxLen) {
      if (win[start + (len % dist)] !== lookahead[len]) {
        break;
      }
      len = len + 1;
    }
    if (len > bestLen) {
      bestLen = len;
      bestDist = dist;
    }
  }

  return bestLen * 65536 + bestDist;
}
`;
}

function makeInflateBitsSource(dataSize: number): string {
  return `
export function run(): number {
  // Generate ${dataSize} bytes of test data
  const input: number[] = [];
  for (let i = 0; i < ${dataSize}; i++) {
    if (i % 7 === 0) {
      input.push(72);
    } else if (i % 11 === 0) {
      input.push(101);
    } else {
      input.push((i * 31 + 17) & 255);
    }
  }

  // Inflate-style bit reader (simulates Huffman decode hot loop)
  let hold = 0;
  let bits = 0;
  let pos = 0;
  let result = 0;

  while (pos < ${dataSize}) {
    while (bits < 16 && pos < ${dataSize}) {
      hold = hold + (input[pos] * (1 << bits));
      pos = pos + 1;
      bits = bits + 8;
    }
    while (bits >= 8) {
      const code = hold & 255;
      hold = hold >>> 8;
      bits = bits - 8;
      if (code < 128) {
        result = result + code;
      } else {
        const extra = (code >>> 4) & 7;
        const base = code & 15;
        result = result + base + extra;
      }
    }
  }

  return result;
}
`;
}

// ---------------------------------------------------------------------------
// JS reference implementations (same algorithms)
// ---------------------------------------------------------------------------

function jsAdler32Run(dataSize: number): number {
  const buf: number[] = [];
  for (let i = 0; i < dataSize; i++) {
    if (i % 7 === 0) buf.push(72);
    else if (i % 11 === 0) buf.push(101);
    else buf.push((i * 31 + 17) & 255);
  }

  let s1 = 1,
    s2 = 0,
    pos = 0,
    n = 0,
    len = dataSize;
  while (len !== 0) {
    n = len > 2000 ? 2000 : len;
    len -= n;
    do {
      s1 += buf[pos++];
      s2 += s1;
    } while (--n);
    s1 %= 65521;
    s2 %= 65521;
  }
  return s1 + s2 * 65536;
}

function jsCrc32Run(dataSize: number): number {
  // Build table
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    table.push(c);
  }

  const buf: number[] = [];
  for (let i = 0; i < dataSize; i++) {
    if (i % 7 === 0) buf.push(72);
    else if (i % 11 === 0) buf.push(101);
    else buf.push((i * 31 + 17) & 255);
  }

  let crc = -1;
  for (let i = 0; i < dataSize; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]!) & 0xff]!;
  }
  return crc ^ -1;
}

function jsLz77Run(windowSize: number): number {
  const win: number[] = [];
  for (let i = 0; i < windowSize; i++) win.push((i * 7 + 3) & 255);

  const lookahead: number[] = [];
  const matchStart = windowSize - 50;
  for (let i = 0; i < 64; i++) {
    if (i < 30) lookahead.push(win[matchStart + i]!);
    else lookahead.push((i * 13 + 5) & 255);
  }

  const maxDist = Math.min(windowSize, 256);
  const maxLen = 258;
  let bestLen = 0,
    bestDist = 0;

  for (let dist = 1; dist <= maxDist && dist <= windowSize; dist++) {
    let len = 0;
    const start = windowSize - dist;
    while (len < 64 && len < maxLen) {
      if (win[start + (len % dist)] !== lookahead[len]) break;
      len++;
    }
    if (len > bestLen) {
      bestLen = len;
      bestDist = dist;
    }
  }
  return bestLen * 65536 + bestDist;
}

function jsInflateBitsRun(dataSize: number): number {
  const input: number[] = [];
  for (let i = 0; i < dataSize; i++) {
    if (i % 7 === 0) input.push(72);
    else if (i % 11 === 0) input.push(101);
    else input.push((i * 31 + 17) & 255);
  }

  let hold = 0,
    bits = 0,
    pos = 0,
    result = 0;
  while (pos < dataSize) {
    while (bits < 16 && pos < dataSize) {
      hold += input[pos++]! << bits;
      bits += 8;
    }
    while (bits >= 8) {
      const code = hold & 0xff;
      hold >>>= 8;
      bits -= 8;
      if (code < 128) result += code;
      else {
        result += (code & 0x0f) + ((code >>> 4) & 0x07);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Compilation + instantiation
// ---------------------------------------------------------------------------

interface WasmModule {
  exports: Record<string, Function>;
  binarySize: number;
  compileMs: number;
}

async function compileModule(source: string, fast: boolean): Promise<WasmModule | null> {
  try {
    const t0 = performance.now();
    const result = compile(source, { fast });
    const compileMs = performance.now() - t0;

    if (!result.success) {
      const msgs = result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n");
      console.error(`  Compilation failed (fast=${fast}):\n${msgs}`);
      return null;
    }

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    if ((imports as any).setExports) {
      (imports as any).setExports(instance.exports as Record<string, Function>);
    }

    return {
      exports: instance.exports as Record<string, Function>,
      binarySize: result.binary.byteLength,
      compileMs,
    };
  } catch (err) {
    console.error(`  Module error (fast=${fast}):`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface BenchResult {
  name: string;
  strategy: string;
  medianMs: number;
  throughputMBs?: number;
  binarySize?: number;
  compileMs?: number;
}

function runTimed(
  fn: () => void,
  iterations: number,
  warmup: number = 5,
): { totalMs: number; avgMs: number; medianMs: number } {
  for (let i = 0; i < warmup; i++) fn();

  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    timings.push(performance.now() - t0);
  }

  timings.sort((a, b) => a - b);
  const totalMs = timings.reduce((s, t) => s + t, 0);
  const mid = timings.length >> 1;
  const medianMs = timings.length % 2 ? timings[mid]! : (timings[mid - 1]! + timings[mid]!) / 2;

  return { totalMs, avgMs: totalMs / iterations, medianMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== pako kernel benchmark: js2wasm Wasm vs JS ===\n");

  const ITERATIONS = 50;
  const results: BenchResult[] = [];

  // === Correctness verification with small data ===
  console.log("Verifying correctness (256-byte data)...");

  const adlerVerify = await compileModule(makeAdler32Source(256), true);
  if (adlerVerify) {
    const wasmResult = (adlerVerify.exports.run as Function)();
    const jsResult = jsAdler32Run(256);
    console.log(`  adler32: JS=${jsResult} Wasm=${wasmResult} ${wasmResult === jsResult ? "OK" : "MISMATCH"}`);
  }

  const crc32Verify = await compileModule(makeCrc32Source(256), true);
  if (crc32Verify) {
    const wasmResult = (crc32Verify.exports.run as Function)();
    const jsResult = jsCrc32Run(256);
    console.log(`  crc32:   JS=${jsResult} Wasm=${wasmResult} ${wasmResult === jsResult ? "OK" : "MISMATCH"}`);
  }

  const lz77Verify = await compileModule(makeLz77Source(256), true);
  if (lz77Verify) {
    const wasmResult = (lz77Verify.exports.run as Function)();
    const jsResult = jsLz77Run(256);
    console.log(`  lz77:    JS=${jsResult} Wasm=${wasmResult} ${wasmResult === jsResult ? "OK" : "MISMATCH"}`);
  }

  const inflVerify = await compileModule(makeInflateBitsSource(256), true);
  if (inflVerify) {
    const wasmResult = (inflVerify.exports.run as Function)();
    const jsResult = jsInflateBitsRun(256);
    console.log(`  inflate: JS=${jsResult} Wasm=${wasmResult} ${wasmResult === jsResult ? "OK" : "MISMATCH"}`);
  }

  // === Benchmark each kernel ===
  // Using 1KB and 10KB sizes (100KB takes too long to compile for each variant)
  const benchSizes = [1024, 10240];

  // --- Adler32 ---
  console.log("\n--- Adler32 Benchmark ---");
  for (const size of benchSizes) {
    const sizeName = `${size / 1024}KB`;
    const throughputBase = size / 1024 / 1024;

    // JS baseline
    const jsTime = runTimed(() => jsAdler32Run(size), ITERATIONS);
    results.push({
      name: `adler32-${sizeName}`,
      strategy: "js",
      medianMs: jsTime.medianMs,
      throughputMBs: throughputBase / (jsTime.medianMs / 1000),
    });

    // Wasm host-call
    const hostMod = await compileModule(makeAdler32Source(size), false);
    if (hostMod) {
      const fn = hostMod.exports.run as Function;
      const t = runTimed(() => fn(), ITERATIONS);
      results.push({
        name: `adler32-${sizeName}`,
        strategy: "host-call",
        medianMs: t.medianMs,
        throughputMBs: throughputBase / (t.medianMs / 1000),
        binarySize: hostMod.binarySize,
        compileMs: hostMod.compileMs,
      });
    }

    // Wasm gc-native
    const gcMod = await compileModule(makeAdler32Source(size), true);
    if (gcMod) {
      const fn = gcMod.exports.run as Function;
      const t = runTimed(() => fn(), ITERATIONS);
      results.push({
        name: `adler32-${sizeName}`,
        strategy: "gc-native",
        medianMs: t.medianMs,
        throughputMBs: throughputBase / (t.medianMs / 1000),
        binarySize: gcMod.binarySize,
        compileMs: gcMod.compileMs,
      });
    }

    const host = results.find((r) => r.name === `adler32-${sizeName}` && r.strategy === "host-call");
    const gc = results.find((r) => r.name === `adler32-${sizeName}` && r.strategy === "gc-native");
    console.log(
      `  ${sizeName}: JS=${jsTime.medianMs.toFixed(3)}ms` +
        (host ? ` Host=${host.medianMs.toFixed(3)}ms(${(jsTime.medianMs / host.medianMs).toFixed(2)}x)` : "") +
        (gc ? ` GC=${gc.medianMs.toFixed(3)}ms(${(jsTime.medianMs / gc.medianMs).toFixed(2)}x)` : ""),
    );
  }

  // --- CRC32 ---
  console.log("\n--- CRC32 Benchmark ---");
  for (const size of benchSizes) {
    const sizeName = `${size / 1024}KB`;
    const throughputBase = size / 1024 / 1024;

    const jsTime = runTimed(() => jsCrc32Run(size), ITERATIONS);
    results.push({
      name: `crc32-${sizeName}`,
      strategy: "js",
      medianMs: jsTime.medianMs,
      throughputMBs: throughputBase / (jsTime.medianMs / 1000),
    });

    const gcMod = await compileModule(makeCrc32Source(size), true);
    if (gcMod) {
      const fn = gcMod.exports.run as Function;
      const t = runTimed(() => fn(), ITERATIONS);
      results.push({
        name: `crc32-${sizeName}`,
        strategy: "gc-native",
        medianMs: t.medianMs,
        throughputMBs: throughputBase / (t.medianMs / 1000),
        binarySize: gcMod.binarySize,
        compileMs: gcMod.compileMs,
      });
      console.log(
        `  ${sizeName}: JS=${jsTime.medianMs.toFixed(3)}ms GC=${t.medianMs.toFixed(3)}ms ratio=${(jsTime.medianMs / t.medianMs).toFixed(2)}x`,
      );
    } else {
      console.log(`  ${sizeName}: JS=${jsTime.medianMs.toFixed(3)}ms GC=FAIL`);
    }
  }

  // --- LZ77 Match Finder ---
  console.log("\n--- LZ77 Match Finder Benchmark ---");
  for (const ws of [256, 1024]) {
    const jsTime = runTimed(() => jsLz77Run(ws), ITERATIONS);
    results.push({ name: `lz77-w${ws}`, strategy: "js", medianMs: jsTime.medianMs });

    const gcMod = await compileModule(makeLz77Source(ws), true);
    if (gcMod) {
      const fn = gcMod.exports.run as Function;
      const t = runTimed(() => fn(), ITERATIONS);
      results.push({
        name: `lz77-w${ws}`,
        strategy: "gc-native",
        medianMs: t.medianMs,
        binarySize: gcMod.binarySize,
        compileMs: gcMod.compileMs,
      });
      console.log(
        `  window=${ws}: JS=${jsTime.medianMs.toFixed(3)}ms GC=${t.medianMs.toFixed(3)}ms ratio=${(jsTime.medianMs / t.medianMs).toFixed(2)}x`,
      );
    } else {
      console.log(`  window=${ws}: JS=${jsTime.medianMs.toFixed(3)}ms GC=FAIL`);
    }
  }

  // --- Inflate Bit-Reader ---
  console.log("\n--- Inflate Bit-Reader Benchmark ---");
  for (const size of [256, 1024]) {
    const sizeName = `${size}B`;

    const jsTime = runTimed(() => jsInflateBitsRun(size), ITERATIONS);
    results.push({ name: `inflate-bits-${sizeName}`, strategy: "js", medianMs: jsTime.medianMs });

    const gcMod = await compileModule(makeInflateBitsSource(size), true);
    if (gcMod) {
      const fn = gcMod.exports.run as Function;
      const t = runTimed(() => fn(), ITERATIONS);
      results.push({
        name: `inflate-bits-${sizeName}`,
        strategy: "gc-native",
        medianMs: t.medianMs,
        binarySize: gcMod.binarySize,
        compileMs: gcMod.compileMs,
      });
      console.log(
        `  ${sizeName}: JS=${jsTime.medianMs.toFixed(3)}ms GC=${t.medianMs.toFixed(3)}ms ratio=${(jsTime.medianMs / t.medianMs).toFixed(2)}x`,
      );
    } else {
      console.log(`  ${sizeName}: JS=${jsTime.medianMs.toFixed(3)}ms GC=FAIL`);
    }
  }

  // === Summary Table ===
  console.log("\n=== Summary ===\n");
  console.log("Kernel              | JS (ms)  | GC (ms)  | Ratio | Throughput");
  console.log("--------------------|----------|----------|-------|----------");

  const allNames = [...new Set(results.map((r) => r.name))];
  for (const name of allNames) {
    const js = results.find((r) => r.name === name && r.strategy === "js");
    const gc = results.find((r) => r.name === name && r.strategy === "gc-native");
    if (!js) continue;

    const ratio = gc ? (js.medianMs / gc.medianMs).toFixed(2) + "x" : "N/A";
    const tp = gc?.throughputMBs ? gc.throughputMBs.toFixed(1) + " MB/s" : "-";
    console.log(
      `${name.padEnd(20)}| ${js.medianMs.toFixed(3).padStart(8)} | ${gc ? gc.medianMs.toFixed(3).padStart(8) : "     N/A"} | ${ratio.padStart(5)} | ${tp}`,
    );
  }

  // === Wasm Module Sizes ===
  console.log("\n=== Wasm Module Sizes (gc-native) ===\n");
  for (const r of results.filter((r) => r.strategy === "gc-native" && r.binarySize)) {
    console.log(`  ${r.name}: ${r.binarySize} bytes (compiled in ${r.compileMs!.toFixed(1)}ms)`);
  }

  // === Blocking patterns for full pako ===
  console.log("\n=== Blocking Patterns for Full pako Compilation ===\n");
  console.log("The following patterns in pako's source prevent full compilation:\n");
  console.log("1. CommonJS require()/module.exports - js2wasm expects ES modules");
  console.log("2. Classes (Inflate, Deflate, ZStream, GZheader) - not yet supported");
  console.log("3. Untyped object property access (strm.state, state.mode)");
  console.log("4. Uint8Array/Uint32Array constructors - typed arrays not supported");
  console.log("5. Object.prototype.toString - host object methods unavailable");
  console.log("6. Labeled break across nested loops (break top; in inffast.js)");
  console.log("7. Dynamic property access with untyped variables");
  console.log("8. String operations (error messages, text encoding)");
  console.log("\nThe core compute kernels compile successfully when rewritten");
  console.log("as clean TypeScript with explicit types and number[] arrays.");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
