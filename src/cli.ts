#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { compile } from "./index.js";

const args = process.argv.slice(2);

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
let emitWasm = true;
let emitWat = true;
let emitDts = true;
let watOnly = false;
let optimize: boolean | 1 | 2 | 3 | 4 = false;
let target: "gc" | "linear" | "wasi" | undefined;
let emitWit = false;

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

const result = compile(source, { ...(optimize ? { optimize } : {}), ...(target ? { target } : {}), ...(emitWit ? { wit: true } : {}) });

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
