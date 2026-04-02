#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as ts from "typescript";
import {
  buildImports,
  compileMulti,
  instantiateWasm,
} from "./compiler-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HELPERS_PATH = resolve(ROOT, "playground", "examples", "benchmarks", "helpers.ts");
const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "playground-benchmark-sidebar.json");
const PUBLIC_PATH = resolve(ROOT, "playground", "public", "benchmarks", "results", "playground-benchmark-sidebar.json");

const HELPERS_SOURCE = readFileSync(HELPERS_PATH, "utf8");

const BENCHMARKS = [
  { path: "examples/benchmarks/fib.ts", exportName: "bench_fib" },
  { path: "examples/benchmarks/loop.ts", exportName: "bench_loop" },
  { path: "examples/benchmarks/string.ts", exportName: "bench_string" },
  { path: "examples/benchmarks/array.ts", exportName: "bench_array" },
];

function stripImportsAndExports(source) {
  return source
    .replace(/^\s*import\s+[^;]+;\s*$/gm, "")
    .replace(/^export\s+/gm, "");
}

function buildJsFactorySource(source, exportName) {
  const transpiled = ts.transpileModule(stripImportsAndExports(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return `${transpiled}\nreturn { ${exportName} };`;
}

function calibrate(fn) {
  let iters = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 100) {
    fn();
    iters++;
  }
  return Math.max(10, Math.ceil((iters / 100) * 300));
}

function timeIt(fn, iters) {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return performance.now() - t0;
}

async function measureBenchmark(entryPath, exportName) {
  const absEntryPath = resolve(ROOT, "playground", entryPath);
  const source = readFileSync(absEntryPath, "utf8");

  const result = compileMulti({
    [entryPath]: source,
    "examples/benchmarks/helpers.ts": HELPERS_SOURCE,
  }, entryPath);

  if (!result.success) {
    throw new Error(`Compilation failed for ${entryPath}:\n${result.errors.map((e) => e.message).join("\n")}`);
  }

  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  if (imports.setExports) imports.setExports(instance.exports);
  const wasmFn = instance.exports[exportName];
  if (typeof wasmFn !== "function") {
    throw new Error(`Missing wasm export ${exportName} in ${entryPath}`);
  }

  const jsFactory = new Function(buildJsFactorySource(source, exportName));
  const jsExports = jsFactory();
  const jsFn = jsExports[exportName];
  if (typeof jsFn !== "function") {
    throw new Error(`Missing JS export ${exportName} in ${entryPath}`);
  }

  for (let i = 0; i < 50; i++) {
    wasmFn();
    jsFn();
  }

  const iters = calibrate(wasmFn);
  const wasmMs = timeIt(wasmFn, iters);
  const jsMs = timeIt(jsFn, iters);

  return {
    path: entryPath,
    wasmUs: (wasmMs / iters) * 1000,
    jsUs: (jsMs / iters) * 1000,
  };
}

const snapshot = [];
for (const bench of BENCHMARKS) {
  try {
    snapshot.push(await measureBenchmark(bench.path, bench.exportName));
  } catch (error) {
    console.error(`Failed benchmark snapshot for ${bench.path}`);
    throw error;
  }
}

mkdirSync(dirname(RESULTS_PATH), { recursive: true });
writeFileSync(RESULTS_PATH, JSON.stringify(snapshot, null, 2) + "\n");
mkdirSync(dirname(PUBLIC_PATH), { recursive: true });
copyFileSync(RESULTS_PATH, PUBLIC_PATH);
console.log(`Updated ${RESULTS_PATH}`);
console.log(`Updated ${PUBLIC_PATH}`);
