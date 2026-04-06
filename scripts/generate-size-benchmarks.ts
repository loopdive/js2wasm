#!/usr/bin/env npx tsx
/**
 * Generate module size + cold start benchmarks for the landing page.
 *
 * For each benchmark source:
 *   - JS source size (raw + gzip)
 *   - Wasm binary size (raw + gzip)
 *   - JS parse time (new Function(transpiled))
 *   - Wasm compile time (new WebAssembly.Module(binary))
 *
 * Outputs:
 *   benchmarks/results/size-benchmarks.json
 *   public/benchmarks/results/size-benchmarks.json  (copy for Vite dev server)
 *
 * Usage:
 *   pnpm run generate:size-benchmarks
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as ts from "typescript";
import { compile, compileMulti } from "../src/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const HELPERS_PATH = path.resolve(ROOT, "playground", "examples", "benchmarks", "helpers.ts");
const RESULTS_PATH = path.resolve(ROOT, "benchmarks", "results", "size-benchmarks.json");
const PUBLIC_PATH = path.resolve(ROOT, "public", "benchmarks", "results", "size-benchmarks.json");

const HELPERS_SOURCE = fs.readFileSync(HELPERS_PATH, "utf8");

// ---------------------------------------------------------------------------
// Inline snippets for the how-it-works section (match what's shown in HTML)
// ---------------------------------------------------------------------------

const HOW_FIB_JS = `function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export function run() {
  return fibonacci(10);
}`;

const HOW_FIB_TS = `function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
export function run(): number {
  return fibonacci(10);
}`;

const HOW_DOM_JS = `const el = document.createElement("div");
el.textContent = "Hello from Wasm";
el.style.color = "blue";
document.body.appendChild(el);`;

const HOW_DOM_TS = `const el = document.createElement("div");
el.textContent = "Hello from Wasm";
el.style.color = "blue";
document.body.appendChild(el);`;

// ---------------------------------------------------------------------------
// Benchmark files (playground/examples/benchmarks/)
// ---------------------------------------------------------------------------

const BENCHMARKS = [
  { name: "fib", label: "fibonacci", path: "examples/benchmarks/fib.ts" },
  { name: "loop", label: "loop 1M", path: "examples/benchmarks/loop.ts" },
  { name: "string", label: "string concat", path: "examples/benchmarks/string.ts" },
  { name: "array", label: "array fill+sum", path: "examples/benchmarks/array.ts" },
  { name: "dom", label: "DOM 100 els", path: "examples/benchmarks/dom.ts" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gzip(data: Buffer | Uint8Array): number {
  return zlib.gzipSync(data).byteLength;
}

function transpileToJs(tsSource: string): string {
  // Strip imports/exports for new Function() compatibility
  const stripped = tsSource.replace(/^\s*import\s+[^;]+;\s*$/gm, "").replace(/^export\s+/gm, "");
  const result = ts.transpileModule(stripped, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  });
  return result.outputText;
}

/** Measure time in ms for a synchronous operation (median over N iterations). */
function timeSync(fn: () => void, iterations = 20): number {
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  const mid = timings.length >> 1;
  return timings.length % 2 ? timings[mid]! : (timings[mid - 1]! + timings[mid]!) / 2;
}

interface SizeEntry {
  name: string;
  label: string;
  jsSizeRaw: number;
  jsSizeGzip: number;
  wasmSizeRaw: number;
  wasmSizeGzip: number;
  jsParseMs: number;
  wasmCompileMs: number;
}

function measureSizes(name: string, label: string, jsSrc: string, tsSrc: string): SizeEntry | null {
  // Compile TypeScript → Wasm
  const result = compile(tsSrc, { fileName: `${name}.ts` });
  if (!result.success) {
    console.error(`  [${name}] compile failed: ${result.errors[0]?.message}`);
    return null;
  }

  const wasmBinary = result.binary;
  const jsBuf = Buffer.from(jsSrc, "utf8");

  // Gzip sizes
  const jsSizeRaw = jsBuf.byteLength;
  const jsSizeGzip = gzip(jsBuf);
  const wasmSizeRaw = wasmBinary.byteLength;
  const wasmSizeGzip = gzip(wasmBinary);

  // JS parse time: new Function(transpiled body)
  const transpiledJs = transpileToJs(tsSrc);
  const jsParseMs = timeSync(() => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(transpiledJs);
  });

  // Wasm compile time: new WebAssembly.Module(binary) (synchronous)
  const binaryBuffer = Buffer.from(wasmBinary);
  const wasmCompileMs = timeSync(() => {
    new WebAssembly.Module(binaryBuffer);
  });

  return {
    name,
    label,
    jsSizeRaw,
    jsSizeGzip,
    wasmSizeRaw,
    wasmSizeGzip,
    jsParseMs: Math.round(jsParseMs * 1e4) / 1e4,
    wasmCompileMs: Math.round(wasmCompileMs * 1e4) / 1e4,
  };
}

function measureMultiSizes(name: string, label: string, entryPath: string): SizeEntry | null {
  const absPath = path.resolve(ROOT, "playground", entryPath);
  const tsSrc = fs.readFileSync(absPath, "utf8");

  // Compile using compileMulti to resolve helpers import
  const result = compileMulti(
    {
      [entryPath]: tsSrc,
      "examples/benchmarks/helpers.ts": HELPERS_SOURCE,
    },
    entryPath,
  );

  if (!result.success) {
    console.error(`  [${name}] compile failed: ${result.errors[0]?.message}`);
    return null;
  }

  const wasmBinary = result.binary;

  // For the JS side, use the raw TypeScript source as "what the user writes"
  const jsBuf = Buffer.from(tsSrc, "utf8");
  const jsSizeRaw = jsBuf.byteLength;
  const jsSizeGzip = gzip(jsBuf);
  const wasmSizeRaw = wasmBinary.byteLength;
  const wasmSizeGzip = gzip(wasmBinary);

  // JS parse time: transpile + new Function
  const transpiledJs = transpileToJs(tsSrc);
  const jsParseMs = timeSync(() => {
    new Function(transpiledJs);
  });

  // Wasm compile time
  const binaryBuffer = Buffer.from(wasmBinary);
  const wasmCompileMs = timeSync(() => {
    new WebAssembly.Module(binaryBuffer);
  });

  return {
    name,
    label,
    jsSizeRaw,
    jsSizeGzip,
    wasmSizeRaw,
    wasmSizeGzip,
    jsParseMs: Math.round(jsParseMs * 1e4) / 1e4,
    wasmCompileMs: Math.round(wasmCompileMs * 1e4) / 1e4,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Generating size benchmarks...\n");

// 1. How-it-works snippets
console.log("How-it-works snippets:");

process.stdout.write("  fib ...");
const fibEntry = measureSizes("fib", "fibonacci", HOW_FIB_JS, HOW_FIB_TS);
if (fibEntry) {
  console.log(
    ` JS: ${fibEntry.jsSizeGzip}B gzip / ${fibEntry.jsParseMs.toFixed(4)}ms | Wasm: ${fibEntry.wasmSizeGzip}B gzip / ${fibEntry.wasmCompileMs.toFixed(4)}ms`,
  );
}

process.stdout.write("  dom ...");
const domEntry = measureSizes("dom", "DOM append", HOW_DOM_JS, HOW_DOM_TS);
if (domEntry) {
  console.log(
    ` JS: ${domEntry.jsSizeGzip}B gzip / ${domEntry.jsParseMs.toFixed(4)}ms | Wasm: ${domEntry.wasmSizeGzip}B gzip / ${domEntry.wasmCompileMs.toFixed(4)}ms`,
  );
}

// 2. Benchmark files
console.log("\nPlayground benchmarks:");

const benchmarkResults: SizeEntry[] = [];
for (const bench of BENCHMARKS) {
  process.stdout.write(`  ${bench.name} ...`);
  const entry = measureMultiSizes(bench.name, bench.label, bench.path);
  if (entry) {
    benchmarkResults.push(entry);
    console.log(
      ` JS: ${entry.jsSizeGzip}B gzip / ${entry.jsParseMs.toFixed(4)}ms | Wasm: ${entry.wasmSizeGzip}B gzip / ${entry.wasmCompileMs.toFixed(4)}ms`,
    );
  }
}

// 3. Write output
const output = {
  timestamp: new Date().toISOString(),
  howItWorks: {
    fib: fibEntry,
    dom: domEntry,
  },
  benchmarks: benchmarkResults,
};

fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
fs.writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2) + "\n");

fs.mkdirSync(path.dirname(PUBLIC_PATH), { recursive: true });
fs.copyFileSync(RESULTS_PATH, PUBLIC_PATH);

console.log(`\nWrote ${RESULTS_PATH}`);
console.log(`Copied to ${PUBLIC_PATH}`);
