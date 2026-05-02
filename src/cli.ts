#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const args = process.argv.slice(2);

// `--ts7` swaps the parser/checker frontend to `@typescript/native-preview`
// (TS7 Go-port preview, #1288). The decision is made by `src/ts-api.ts` at
// module-load time, so the env var MUST be set before any compiler imports
// resolve. We use a dynamic import below for that reason.
if (args.includes("--ts7")) {
  process.env.JS2WASM_TS7 = "1";
}

const { compile } = await import("./index.js");
const { buildDefaultDefines } = await import("./compiler/define-substitution.js");

if (args.includes("--version") || args.includes("-v")) {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json");
  console.log(pkg.version);
  process.exit(0);
}

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: js2wasm <input.ts> [options]

Compile a TypeScript file to WebAssembly (GC proposal).

Options:
  -o, --out <dir>   Output directory (default: same as input)
  --target <t>      Compilation target: gc (default), linear, wasi
  --wat             Emit only WAT (no binary)
  --no-wat          Skip WAT output
  --no-dts          Skip .d.ts output
  --wit             Generate WIT interface file for Component Model
  -O, --optimize    Run Binaryen wasm-opt optimizer (default: -O3)
  -O1..-O4          Set optimization level (1-4)
  --define K=V      Substitute identifier path K with literal V before parsing.
                    Repeatable. Example:
                      --define process.env.NODE_ENV='"production"'
                    String values must include their own quotes.
  --mode <m>        Shorthand for --define-style production/development build.
                    'production' sets process.env.NODE_ENV="production" and
                    typeof process / typeof window to "undefined".
                    'development' sets process.env.NODE_ENV="development".
  --ts7             Use @typescript/native-preview (TypeScript 7 Go-port) as
                    the parser/checker frontend (preview; full migration
                    tracked in #1029). Equivalent to JS2WASM_TS7=1.
  -v, --version     Print version and exit
  -h, --help        Show this help

Output files:
  <name>.wasm       WebAssembly binary
  <name>.wat        WebAssembly text format
  <name>.d.ts       TypeScript declarations
  <name>.imports.js createImports() helper`);
  process.exit(0);
}

let inputPath: string | undefined;
let outDir: string | undefined;
const emitWasm = true;
let emitWat = true;
let emitDts = true;
let watOnly = false;
let optimize: boolean | 1 | 2 | 3 | 4 = false;
let target: "gc" | "linear" | "wasi" | undefined;
let emitWit = false;
const defines: Record<string, string> = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "-o" || arg === "--out") {
    outDir = args[++i];
  } else if (arg === "--target") {
    const t = args[++i];
    if (t === "gc" || t === "linear" || t === "wasi") {
      target = t;
    } else {
      console.error(`Unknown target: ${t} (expected gc, linear, or wasi)`);
      process.exit(1);
    }
  } else if (arg === "--wat") {
    watOnly = true;
  } else if (arg === "--no-wat") {
    emitWat = false;
  } else if (arg === "--no-dts") {
    emitDts = false;
  } else if (arg === "--wit") {
    emitWit = true;
  } else if (arg === "-O" || arg === "--optimize") {
    optimize = true;
  } else if (/^-O[1-4]$/.test(arg)) {
    optimize = parseInt(arg.slice(2)) as 1 | 2 | 3 | 4;
  } else if (arg === "--define") {
    const kv = args[++i];
    if (!kv) {
      console.error("--define requires a KEY=VALUE argument");
      process.exit(1);
    }
    const eq = kv.indexOf("=");
    if (eq < 0) {
      console.error(`--define expected KEY=VALUE, got: ${kv}`);
      process.exit(1);
    }
    defines[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (arg.startsWith("--define=")) {
    const kv = arg.slice("--define=".length);
    const eq = kv.indexOf("=");
    if (eq < 0) {
      console.error(`--define expected KEY=VALUE, got: ${kv}`);
      process.exit(1);
    }
    defines[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (arg === "--mode") {
    const m = args[++i];
    if (m !== "production" && m !== "development") {
      console.error(`Unknown --mode: ${m} (expected production or development)`);
      process.exit(1);
    }
    Object.assign(defines, buildDefaultDefines(m));
  } else if (arg === "--ts7") {
    // Already handled above (env var was set before dynamic import).
    // No-op here so the unknown-option fallback below doesn't trigger.
  } else if (!arg.startsWith("-")) {
    inputPath = arg;
  } else {
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  }
}

if (!inputPath) {
  console.error("Error: no input file specified");
  process.exit(1);
}

const absInput = resolve(inputPath);
const source = readFileSync(absInput, "utf-8");
const name = basename(absInput, ".ts");
const dir = outDir ? resolve(outDir) : dirname(absInput);

const result = compile(source, {
  ...(optimize ? { optimize } : {}),
  ...(target ? { target } : {}),
  ...(emitWit ? { wit: true } : {}),
  ...(Object.keys(defines).length > 0 ? { define: defines } : {}),
});

if (!result.success) {
  for (const e of result.errors) {
    const severity = e.severity === "warning" ? "warning" : "error";
    console.error(`${absInput}:${e.line}:${e.column} - ${severity}: ${e.message}`);
  }
  process.exit(1);
}

// Print any warnings (e.g. wasm-opt not available)
for (const e of result.errors) {
  if (e.severity === "warning") {
    console.error(`warning: ${e.message}`);
  }
}

if (watOnly) {
  process.stdout.write(result.wat);
  process.exit(0);
}

if (emitWasm) {
  const wasmPath = resolve(dir, `${name}.wasm`);
  writeFileSync(wasmPath, result.binary);
  console.log(`${wasmPath}  (${result.binary.byteLength} bytes)`);
}

if (emitWat) {
  const watPath = resolve(dir, `${name}.wat`);
  writeFileSync(watPath, result.wat);
  console.log(`${watPath}  (${result.wat.length} chars)`);
}

if (emitDts) {
  const dtsPath = resolve(dir, `${name}.d.ts`);
  writeFileSync(dtsPath, result.dts);
  console.log(`${dtsPath}  (${result.dts.length} chars)`);
}

{
  const helperPath = resolve(dir, `${name}.imports.js`);
  writeFileSync(helperPath, result.importsHelper);
  console.log(`${helperPath}  (${result.importsHelper.length} chars)`);
}

if (emitWit && result.wit) {
  const witPath = resolve(dir, `${name}.wit`);
  writeFileSync(witPath, result.wit);
  console.log(`${witPath}  (${result.wit.length} chars)`);
}
