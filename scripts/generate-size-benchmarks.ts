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
const LOADTIME_RESULTS_PATH = path.resolve(ROOT, "benchmarks", "results", "loadtime-benchmarks.json");
const LOADTIME_PUBLIC_PATH = path.resolve(ROOT, "public", "benchmarks", "results", "loadtime-benchmarks.json");
const LOADTIME_RESULTS_DIR = path.resolve(ROOT, "benchmarks", "results", "loadtime");
const LOADTIME_PUBLIC_DIR = path.resolve(ROOT, "public", "benchmarks", "results", "loadtime");

const LOADTIME_RUNTIME_SOURCE = `const jsString = {
  concat: (a, b) => a + b,
  length: (s) => s.length,
  equals: (a, b) => (a === b ? 1 : 0),
  substring: (s, start, end) => s.substring(start, end),
  charCodeAt: (s, i) => s.charCodeAt(i),
};

export function buildStringConstants(stringPool = []) {
  const constants = {};
  for (const s of stringPool) {
    if (!(s in constants)) {
      constants[s] = new WebAssembly.Global({ value: "externref", mutable: false }, s);
    }
  }
  return constants;
}

function resolveImport(intent, deps, callbackState) {
  switch (intent?.type) {
    case "declared_global":
      return () => deps?.[intent.name];
    case "extern_class":
      if (intent.action === "new") {
        const ctor = deps?.globalThis?.[intent.className] ?? globalThis[intent.className];
        return (...args) => new ctor(...args);
      }
      if (intent.action === "method") {
        return (self, ...args) => self[intent.member](...args);
      }
      if (intent.action === "get") {
        return (self) => self[intent.member];
      }
      if (intent.action === "set") {
        return (self, value) => {
          self[intent.member] = value;
        };
      }
      return () => undefined;
    case "builtin":
      if (intent.name === "number_toString") return (v) => String(v);
      if (intent.name === "number_toFixed") return (v, digits) => Number(v).toFixed(digits);
      if (intent.name === "__get_undefined") return () => undefined;
      if (intent.name?.startsWith("__concat_")) return (...parts) => parts.join("");
      return () => undefined;
    case "extern_get":
      return (obj, key) => obj?.[key];
    case "callback_maker":
      return (id, cap) => (...args) => callbackState.getExports()?.[\`__cb_\${id}\`]?.(cap, ...args);
    case "box":
      if (intent.targetType === "boolean") return (v) => Boolean(v);
      return (v) => v;
    case "console_log":
      return (v) => console.log(v);
    case "date_now":
      return () => Date.now();
    default:
      return () => undefined;
  }
}

export function buildImports(manifest, deps = {}, stringPool = []) {
  let wasmExports;
  const callbackState = { getExports: () => wasmExports };
  const env = {};
  for (const imp of manifest ?? []) {
    if (imp.module !== "env" || imp.kind !== "func") continue;
    env[imp.name] = resolveImport(imp.intent, deps, callbackState);
  }
  return {
    env,
    "wasm:js-string": jsString,
    string_constants: buildStringConstants(stringPool),
    setExports(exports) {
      wasmExports = exports;
    },
  };
}

export async function instantiateWasm(binary, env, stringConstants = {}) {
  if (typeof WebAssembly.instantiate === "function") {
    try {
      const { instance } = await WebAssembly.instantiate(binary, { env, string_constants: stringConstants }, {
        builtins: ["js-string"],
        importedStringConstants: "string_constants",
      });
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through.
    }
  }
  const { instance } = await WebAssembly.instantiate(binary, {
    env,
    "wasm:js-string": jsString,
    string_constants: stringConstants,
  });
  return { instance, nativeBuiltins: false };
}

export async function instantiateWasmStreaming(source, env, stringConstants = {}) {
  const response =
    source instanceof Response ? source : source instanceof Promise ? await source : await fetch(source);
  const fallback = response.clone();
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try {
      const { instance } = await WebAssembly.instantiateStreaming(
        response,
        { env, string_constants: stringConstants },
        { builtins: ["js-string"], importedStringConstants: "string_constants" },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through.
    }
  }
  return instantiateWasm(new Uint8Array(await fallback.arrayBuffer()), env, stringConstants);
}
`;

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
  { name: "calendar", label: "default calendar", path: "examples/dom/calendar.ts" },
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

function parseModule(jsSource: string): void {
  const scriptCompatible = jsSource.replace(/^\s*import\s+[^;]+;\s*$/gm, "").replace(/^export\s+/gm, "");
  new Function(scriptCompatible);
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
  hostJsGzip: number;
  wasmTotalGzip: number;
  jsParseMs: number;
  wasmCompileMs: number;
  hostJsParseMs: number;
  wasmTotalMs: number;
}

interface LoadtimeEntry {
  name: string;
  label: string;
  jsUrl: string;
  wasmUrl: string;
  imports: unknown[];
  stringPool: string[];
}

const loadtimeEntries: LoadtimeEntry[] = [];

function measureSizes(name: string, label: string, jsSrc: string, tsSrc: string): SizeEntry | null {
  // Compile TypeScript → Wasm
  const result = compile(tsSrc, { fileName: `${name}.ts`, optimize: 4 });
  if (!result.success) {
    console.error(`  [${name}] compile failed: ${result.errors[0]?.message}`);
    return null;
  }

  const wasmBinary = result.binary;
  const hostJs = result.importsHelper || "";
  const jsBuf = Buffer.from(jsSrc, "utf8");

  // Gzip sizes
  const jsSizeRaw = jsBuf.byteLength;
  const jsSizeGzip = gzip(jsBuf);
  const wasmSizeRaw = wasmBinary.byteLength;
  const wasmSizeGzip = gzip(wasmBinary);
  const hostJsGzip = hostJs ? gzip(Buffer.from(hostJs, "utf8")) : 0;
  const wasmTotalGzip = wasmSizeGzip + hostJsGzip;

  // JS parse time: new Function(transpiled body)
  const transpiledJs = transpileToJs(tsSrc);
  const jsParseMs = timeSync(() => {
    new Function(transpiledJs);
  });

  // Wasm compile time: new WebAssembly.Module(binary) (synchronous)
  const binaryBuffer = Buffer.from(wasmBinary);
  const wasmCompileMs = timeSync(() => {
    new WebAssembly.Module(binaryBuffer);
  });

  // Host JS parse time (strip export keywords for new Function compatibility)
  const hostJsParseMs = hostJs
    ? timeSync(() => {
        parseModule(hostJs);
      })
    : 0;
  const wasmTotalMs = wasmCompileMs + hostJsParseMs;

  return {
    name,
    label,
    jsSizeRaw,
    jsSizeGzip,
    wasmSizeRaw,
    wasmSizeGzip,
    hostJsGzip,
    wasmTotalGzip,
    jsParseMs: Math.round(jsParseMs * 1e4) / 1e4,
    wasmCompileMs: Math.round(wasmCompileMs * 1e4) / 1e4,
    hostJsParseMs: Math.round(hostJsParseMs * 1e4) / 1e4,
    wasmTotalMs: Math.round(wasmTotalMs * 1e4) / 1e4,
  };
}

function measureMultiSizes(name: string, label: string, entryPath: string): SizeEntry | null {
  const absPath = path.resolve(ROOT, "playground", entryPath);
  const tsSrc = fs.readFileSync(absPath, "utf8");
  const usesBenchmarkHelpers =
    entryPath === "examples/benchmarks.ts" ||
    entryPath.startsWith("examples/benchmarks/") ||
    /^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/(?:benchmarks\/)?helpers\.ts["'];?\s*$/m.test(tsSrc);

  // Compile using compileMulti to resolve helpers import
  const result = compileMulti(
    {
      [entryPath]: tsSrc,
      "examples/benchmarks/helpers.ts": HELPERS_SOURCE,
    },
    entryPath,
    { optimize: 4 },
  );

  if (!result.success) {
    console.error(`  [${name}] compile failed: ${result.errors[0]?.message}`);
    return null;
  }

  const wasmBinary = result.binary;
  const hostJs = result.importsHelper || "";

  // For the JS side, include entry + helpers (the JS version imports helpers too)
  const fullJsSrc = usesBenchmarkHelpers ? `${tsSrc}\n${HELPERS_SOURCE}` : tsSrc;
  const jsBuf = Buffer.from(fullJsSrc, "utf8");
  const jsSizeRaw = jsBuf.byteLength;
  const jsSizeGzip = gzip(jsBuf);
  const wasmSizeRaw = wasmBinary.byteLength;
  const wasmSizeGzip = gzip(wasmBinary);
  const hostJsGzip = hostJs ? gzip(Buffer.from(hostJs, "utf8")) : 0;
  const wasmTotalGzip = wasmSizeGzip + hostJsGzip;

  // JS parse time: transpile entry + helpers
  const transpiledJs = transpileToJs(fullJsSrc);
  const jsParseMs = timeSync(() => {
    new Function(transpiledJs);
  });

  // Wasm compile time
  const binaryBuffer = Buffer.from(wasmBinary);
  const wasmCompileMs = timeSync(() => {
    new WebAssembly.Module(binaryBuffer);
  });

  // Host JS parse time (strip export keywords for new Function compatibility)
  const hostJsParseMs = hostJs
    ? timeSync(() => {
        parseModule(hostJs);
      })
    : 0;
  const wasmTotalMs = wasmCompileMs + hostJsParseMs;

  emitLoadtimeArtifacts(name, label, fullJsSrc, result.binary, result.imports, result.stringPool);

  return {
    name,
    label,
    jsSizeRaw,
    jsSizeGzip,
    wasmSizeRaw,
    wasmSizeGzip,
    hostJsGzip,
    wasmTotalGzip,
    jsParseMs: Math.round(jsParseMs * 1e4) / 1e4,
    wasmCompileMs: Math.round(wasmCompileMs * 1e4) / 1e4,
    hostJsParseMs: Math.round(hostJsParseMs * 1e4) / 1e4,
    wasmTotalMs: Math.round(wasmTotalMs * 1e4) / 1e4,
  };
}

function toBrowserModuleSource(source: string): string {
  const stripped = source.replace(/^\s*import\s+[^;]+;\s*$/gm, "").replace(/^export\s+/gm, "");
  return ts.transpileModule(stripped, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }).outputText;
}

function emitLoadtimeArtifacts(
  name: string,
  label: string,
  jsSource: string,
  wasmBinary: Uint8Array,
  imports: unknown[],
  stringPool: string[],
): void {
  const jsRel = `loadtime/${name}.mjs`;
  const wasmRel = `loadtime/${name}.wasm`;
  const jsModuleSource = toBrowserModuleSource(jsSource);

  fs.mkdirSync(LOADTIME_RESULTS_DIR, { recursive: true });
  fs.mkdirSync(LOADTIME_PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOADTIME_RESULTS_DIR, `${name}.mjs`), jsModuleSource);
  fs.writeFileSync(path.join(LOADTIME_PUBLIC_DIR, `${name}.mjs`), jsModuleSource);
  fs.writeFileSync(path.join(LOADTIME_RESULTS_DIR, `${name}.wasm`), wasmBinary);
  fs.writeFileSync(path.join(LOADTIME_PUBLIC_DIR, `${name}.wasm`), wasmBinary);

  loadtimeEntries.push({
    name,
    label,
    jsUrl: jsRel,
    wasmUrl: wasmRel,
    imports,
    stringPool,
  });
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

const loadtimeOutput = {
  timestamp: new Date().toISOString(),
  benchmarks: loadtimeEntries,
};
fs.writeFileSync(LOADTIME_RESULTS_PATH, JSON.stringify(loadtimeOutput, null, 2) + "\n");
fs.writeFileSync(LOADTIME_PUBLIC_PATH, JSON.stringify(loadtimeOutput, null, 2) + "\n");
fs.writeFileSync(path.join(LOADTIME_RESULTS_DIR, "runtime.js"), LOADTIME_RUNTIME_SOURCE);
fs.writeFileSync(path.join(LOADTIME_PUBLIC_DIR, "runtime.js"), LOADTIME_RUNTIME_SOURCE);

console.log(`\nWrote ${RESULTS_PATH}`);
console.log(`Copied to ${PUBLIC_PATH}`);
console.log(`Wrote ${LOADTIME_RESULTS_PATH}`);
console.log(`Copied to ${LOADTIME_PUBLIC_PATH}`);
